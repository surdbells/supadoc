<?php

declare(strict_types=1);

namespace App\Infrastructure\Service;

use App\Domain\Entity\Appointment;
use App\Domain\Enum\AppointmentStatus;
use Predis\Client as RedisClient;
use Psr\Log\LoggerInterface;

/**
 * Who is in a consultation call right now — for the "in the call" indicators on
 * the appointment lists and pages. Short-lived by nature, so it lives in Redis:
 * each call screen sends a heartbeat every ~15 s (and "left" when it leaves),
 * and a participant counts as present until their heartbeat is TTL seconds old.
 *
 * Keys (under the client's prefix):
 *   call:presence:{appointment}:{role}         heartbeat, expires after TTL
 *   call:presence:{appointment}:guest:{gid}    a guest's heartbeat (by guest id)
 *   call:presence:{appointment}:guests         the guest ids that sent one lately
 *   call:live:patient:{patient}                appointments with recent presence, per
 *   call:live:doctor:{specialist}              patient / doctor — so a list never
 *                                              scans their whole history
 *
 * Presence reads `{doctor: bool, patient: bool, guests: list<guest id>}`.
 * Redis trouble never breaks a call or a page: presence just reads as "nobody"
 * ({@see tryForAppointment()} says "unknown" instead, for the recording check).
 */
final class CallPresence
{
    public const TTL = 40;
    public const ROLES = ['patient', 'doctor', 'guest'];
    /** How long an appointment stays in a person's "live" set after a heartbeat. */
    private const LIVE_SET_TTL = 3600;

    private bool $warned = false;

    public function __construct(
        private readonly RedisClient $redis,
        private readonly ?LoggerInterface $logger = null,
    ) {
    }

    /**
     * A heartbeat from `$role` (patient | doctor, or guest with their
     * `$guestId`) in this appointment's call (none for a closed visit or an
     * unaccepted proposal). True when it starts a presence — nobody was
     * counted for them a moment ago (they joined, or rejoined).
     */
    public function mark(Appointment $appointment, string $role, ?string $guestId = null): bool
    {
        $key = $this->participantKey($appointment->getId(), $role, $guestId);
        if (
            $key === null
            || $appointment->getStatus()->isTerminal()
            || $appointment->getStatus() === AppointmentStatus::PROPOSED
        ) {
            return false;
        }
        $id = $appointment->getId();

        return (bool) $this->safely(function () use ($appointment, $id, $key, $role, $guestId): bool {
            $new = $this->redis->get($key) === null;
            $this->redis->setex($key, self::TTL, (string) time());
            if ($role === 'guest') {
                $this->redis->sadd($this->guestSet($id), [(string) $guestId]);
                $this->redis->expire($this->guestSet($id), self::LIVE_SET_TTL);
            }
            foreach ($this->liveSets($appointment) as $set) {
                $this->redis->sadd($set, [$id]);
                $this->redis->expire($set, self::LIVE_SET_TTL);
            }

            return $new;
        }, false);
    }

    /** `$role` (a guest: `$guestId`) left the call (closing the page, ending, navigating away, removed). */
    public function clear(Appointment $appointment, string $role, ?string $guestId = null): void
    {
        $key = $this->participantKey($appointment->getId(), $role, $guestId);
        if ($key === null) {
            return;
        }
        $this->safely(function () use ($appointment, $key, $role, $guestId): void {
            $this->redis->del([$key]);
            if ($role === 'guest') {
                $this->redis->srem($this->guestSet($appointment->getId()), [(string) $guestId]);
            }
        });
    }

    /**
     * The appointment ids of a {@see forPatient()} / {@see forSpecialist()}
     * map that someone is in the call of right now — for the lists that keep
     * a call running over its time "live" (AppointmentRepository::applyWhen()).
     *
     * @param array<string, array{doctor: bool, patient: bool, guests?: list<string>}> $present
     * @return list<string>
     */
    public static function liveIds(array $present): array
    {
        $ids = [];
        foreach ($present as $id => $p) {
            if (($p['doctor'] ?? false) || ($p['patient'] ?? false) || ($p['guests'] ?? []) !== []) {
                $ids[] = (string) $id;
            }
        }

        return $ids;
    }

    /** @return array<string, array{doctor: bool, patient: bool, guests: list<string>}> */
    public function forPatient(string $patientId): array
    {
        return $this->present("call:live:patient:$patientId");
    }

    /** @return array<string, array{doctor: bool, patient: bool, guests: list<string>}> */
    public function forSpecialist(string $specialistId): array
    {
        return $this->present("call:live:doctor:$specialistId");
    }

    /**
     * Who is in this one appointment's call now ("nobody" when Redis can't say).
     *
     * @return array{doctor: bool, patient: bool, guests: list<string>}
     */
    public function forAppointment(Appointment $appointment): array
    {
        return $this->tryForAppointment($appointment) ?? ['doctor' => false, 'patient' => false, 'guests' => []];
    }

    /**
     * Who is in this one appointment's call now, or null when Redis can't say —
     * for checks that must not take "unknown" for "nobody" (recording waits
     * for every guest in the call to agree).
     *
     * @return array{doctor: bool, patient: bool, guests: list<string>}|null
     */
    public function tryForAppointment(Appointment $appointment): ?array
    {
        $id = $appointment->getId();

        return $this->safely(function () use ($id): array {
            $values = array_values((array) $this->redis->mget([$this->key($id, 'doctor'), $this->key($id, 'patient')]));

            return [
                'doctor'  => ($values[0] ?? null) !== null,
                'patient' => ($values[1] ?? null) !== null,
                'guests'  => $this->presentGuests($id),
            ];
        }, null);
    }

    /**
     * Who is present in each appointment of a "live" set; appointments nobody is
     * in any more are dropped from the set.
     *
     * @return array<string, array{doctor: bool, patient: bool, guests: list<string>}>
     */
    private function present(string $set): array
    {
        return $this->safely(function () use ($set): array {
            /** @var list<string> $ids */
            $ids = array_values(array_map('strval', (array) $this->redis->smembers($set)));
            if ($ids === []) {
                return [];
            }
            $keys = [];
            foreach ($ids as $id) {
                $keys[] = $this->key($id, 'doctor');
                $keys[] = $this->key($id, 'patient');
            }
            $values = array_values((array) $this->redis->mget($keys));
            $out = [];
            $gone = [];
            foreach ($ids as $i => $id) {
                $doctor  = ($values[$i * 2] ?? null) !== null;
                $patient = ($values[$i * 2 + 1] ?? null) !== null;
                $guests  = $this->presentGuests($id);
                if ($doctor || $patient || $guests !== []) {
                    $out[$id] = ['doctor' => $doctor, 'patient' => $patient, 'guests' => $guests];
                } else {
                    $gone[] = $id;
                }
            }
            if ($gone !== []) {
                $this->redis->srem($set, $gone);
            }

            return $out;
        }, []);
    }

    /**
     * The guest ids with a live heartbeat in this appointment's call; ids whose
     * heartbeat expired are dropped from its guest set.
     *
     * @return list<string>
     */
    private function presentGuests(string $appointmentId): array
    {
        /** @var list<string> $gids */
        $gids = array_values(array_map('strval', (array) $this->redis->smembers($this->guestSet($appointmentId))));
        if ($gids === []) {
            return [];
        }
        $values = array_values((array) $this->redis->mget(array_map(
            fn (string $gid): string => $this->key($appointmentId, 'guest:' . $gid),
            $gids,
        )));
        $present = [];
        $gone    = [];
        foreach ($gids as $i => $gid) {
            if (($values[$i] ?? null) !== null) {
                $present[] = $gid;
            } else {
                $gone[] = $gid;
            }
        }
        if ($gone !== []) {
            $this->redis->srem($this->guestSet($appointmentId), $gone);
        }
        sort($present);

        return $present;
    }

    /** @return list<string> */
    private function liveSets(Appointment $appointment): array
    {
        return [
            'call:live:patient:' . $appointment->getPatient()->getId(),
            'call:live:doctor:' . $appointment->getSpecialist()->getId(),
        ];
    }

    /** The heartbeat key of one participant, or null for an unknown role (or a guest without an id). */
    private function participantKey(string $appointmentId, string $role, ?string $guestId): ?string
    {
        if (!in_array($role, self::ROLES, true)) {
            return null;
        }
        if ($role === 'guest') {
            return $guestId !== null && $guestId !== '' ? $this->key($appointmentId, 'guest:' . $guestId) : null;
        }

        return $this->key($appointmentId, $role);
    }

    private function key(string $appointmentId, string $role): string
    {
        return "call:presence:$appointmentId:$role";
    }

    private function guestSet(string $appointmentId): string
    {
        return "call:presence:$appointmentId:guests";
    }

    /**
     * @template T
     * @param callable(): T $fn
     * @param T             $fallback
     * @return T
     */
    private function safely(callable $fn, mixed $fallback = null): mixed
    {
        try {
            return $fn();
        } catch (\Throwable $e) {
            if (!$this->warned) {
                $this->warned = true;
                $this->logger?->warning('Call presence unavailable (Redis): ' . $e->getMessage());
            }

            return $fallback;
        }
    }
}
