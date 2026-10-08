<?php

declare(strict_types=1);

namespace App\Infrastructure\Service;

use App\Domain\Entity\Appointment;
use Predis\Client as RedisClient;
use Psr\Log\LoggerInterface;

/**
 * Who is in a consultation call right now — for the "in the call" indicators on
 * the appointment lists and pages. Short-lived by nature, so it lives in Redis:
 * each call screen sends a heartbeat every ~15 s (and "left" when it leaves),
 * and a participant counts as present until their heartbeat is TTL seconds old.
 *
 * Keys (under the client's prefix):
 *   call:presence:{appointment}:{role}   heartbeat, expires after TTL
 *   call:live:patient:{patient}          appointments with recent presence, per
 *   call:live:doctor:{specialist}        patient / doctor — so a list never
 *                                        scans their whole history
 *
 * Redis trouble never breaks a call or a page: presence just reads as "nobody".
 */
final class CallPresence
{
    public const TTL = 40;
    public const ROLES = ['patient', 'doctor'];
    /** How long an appointment stays in a person's "live" set after a heartbeat. */
    private const LIVE_SET_TTL = 3600;

    private bool $warned = false;

    public function __construct(
        private readonly RedisClient $redis,
        private readonly ?LoggerInterface $logger = null,
    ) {
    }

    /** A heartbeat from `$role` (patient | doctor) in this appointment's call. */
    public function mark(Appointment $appointment, string $role): void
    {
        if (!in_array($role, self::ROLES, true) || $appointment->getStatus()->isTerminal()) {
            return;
        }
        $id = $appointment->getId();
        $this->safely(function () use ($appointment, $id, $role): void {
            $this->redis->setex($this->key($id, $role), self::TTL, (string) time());
            foreach ($this->liveSets($appointment) as $set) {
                $this->redis->sadd($set, [$id]);
                $this->redis->expire($set, self::LIVE_SET_TTL);
            }
        });
    }

    /** `$role` left the call (closing the page, ending, navigating away). */
    public function clear(Appointment $appointment, string $role): void
    {
        if (!in_array($role, self::ROLES, true)) {
            return;
        }
        $this->safely(fn () => $this->redis->del([$this->key($appointment->getId(), $role)]));
    }

    /** @return array<string, array{doctor: bool, patient: bool}> */
    public function forPatient(string $patientId): array
    {
        return $this->present("call:live:patient:$patientId");
    }

    /** @return array<string, array{doctor: bool, patient: bool}> */
    public function forSpecialist(string $specialistId): array
    {
        return $this->present("call:live:doctor:$specialistId");
    }

    /**
     * Who is present in each appointment of a "live" set; appointments nobody is
     * in any more are dropped from the set.
     *
     * @return array<string, array{doctor: bool, patient: bool}>
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
                if ($doctor || $patient) {
                    $out[$id] = ['doctor' => $doctor, 'patient' => $patient];
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

    /** @return list<string> */
    private function liveSets(Appointment $appointment): array
    {
        return [
            'call:live:patient:' . $appointment->getPatient()->getId(),
            'call:live:doctor:' . $appointment->getSpecialist()->getId(),
        ];
    }

    private function key(string $appointmentId, string $role): string
    {
        return "call:presence:$appointmentId:$role";
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
