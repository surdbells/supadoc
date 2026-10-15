<?php

declare(strict_types=1);

namespace App\Domain\Call;

use App\Domain\Entity\Appointment;
use App\Domain\Enum\AppointmentStatus;
use App\Domain\Settings\ClinicTime;
use DateTimeImmutable;

/**
 * Who may use a call-access token (the signed link in each party's emails)
 * right now, and who is in the call. Pure — the caller resolves the token and
 * loads the appointment.
 *
 * Every role: a cancelled or completed consultation has no call (410), nor an
 * unaccepted follow-up proposal (409). Guests also: they must still be on the
 * guest list (410 once removed) and may join from GUEST_EARLY_MINUTES before
 * the start (425 before that, with `starts_at` / `opens_at` to count down) until
 * GUEST_LATE_MINUTES after the booked slot ends (410 after); one still in a
 * call that runs over keeps it for at most GUEST_OVERRUN_HOURS more. The
 * patient and the doctor keep their own timing (the doctor may join any time).
 *
 * Problems are [status, message, errors] with `errors.call` (the message — the
 * first field, so a client's apiErrorMessage shows it) and `errors.code`:
 * cancelled | ended | not_confirmed | withdrawn | too_early.
 */
final class CallAccess
{
    public const GUEST_EARLY_MINUTES = 15;
    public const GUEST_LATE_MINUTES  = 60;
    /** A guest in a call that runs over renews past their window for at most this long. */
    public const GUEST_OVERRUN_HOURS = 3;
    /**
     * How long a guest's Agora token lasts (they renew by joining again, which
     * re-checks the link) — short, so a removed guest's ends soon even when
     * Agora can't put them out of the channel.
     */
    public const GUEST_RTC_TTL = 600;

    public const CANCELLED = 'This consultation was cancelled.';
    public const ENDED     = 'This consultation has ended.';
    public const WITHDRAWN = 'This invitation was withdrawn. Ask the person who invited you if you think this is a mistake.';
    public const NOT_YET   = "This follow-up isn't confirmed yet, so there is no call to join. The patient can accept it in VideoMed.";

    /** When the booked slot ends. */
    public static function endsAt(Appointment $appointment): DateTimeImmutable
    {
        return $appointment->getScheduledAt()->modify('+' . $appointment->getSpecialist()->getSlotMinutes() . ' minutes');
    }

    /** The earliest a guest can join. */
    public static function guestOpensAt(Appointment $appointment): DateTimeImmutable
    {
        return $appointment->getScheduledAt()->modify('-' . self::GUEST_EARLY_MINUTES . ' minutes');
    }

    /** The latest a guest can join (or be invited, or accept the notice). */
    public static function guestClosesAt(Appointment $appointment): DateTimeImmutable
    {
        return self::endsAt($appointment)->modify('+' . self::GUEST_LATE_MINUTES . ' minutes');
    }

    /** The very latest a guest's link works — a guest still in a call that runs over included. */
    public static function guestRenewsUntil(Appointment $appointment): DateTimeImmutable
    {
        return self::guestClosesAt($appointment)->modify('+' . self::GUEST_OVERRUN_HOURS . ' hours');
    }

    /** Whether this guest may hold an Agora token that hasn't expired: one was issued within GUEST_RTC_TTL. */
    public static function guestMayHoldToken(array $guest, DateTimeImmutable $now): bool
    {
        $issued = self::guestTime($guest, 'rtc_issued_at');

        return $issued !== null && $now->getTimestamp() - $issued->getTimestamp() < self::GUEST_RTC_TTL;
    }

    /**
     * Whether this guest may be in the call even without a heartbeat (the
     * moments between joining and the first one): a token issued within its
     * lifetime that they haven't left the call since.
     */
    public static function guestMayBeConnected(array $guest, DateTimeImmutable $now): bool
    {
        if (!self::guestMayHoldToken($guest, $now)) {
            return false;
        }
        $left = self::guestTime($guest, 'left_at');

        // Within the same second it's unclear which came first: count them in.
        return $left === null || $left <= self::guestTime($guest, 'rtc_issued_at');
    }

    /**
     * The guest entry a guest token stands for, or null when they are no
     * longer invited. A token with a `gid` matches that guest; an older one
     * (uid 3, 4, 5 in invitation order, no gid) matches the same guest while
     * they are still on the list ({@see Appointment::findLegacyGuest()}).
     *
     * @param array{role:string, uid:int, name:string, gid:?string} $claims
     * @return array<string,mixed>|null
     */
    public static function guestFor(Appointment $appointment, array $claims): ?array
    {
        if (($claims['role'] ?? '') !== 'guest') {
            return null;
        }
        $gid = $claims['gid'] ?? null;

        return is_string($gid) && $gid !== ''
            ? $appointment->findGuest($gid)
            : $appointment->findLegacyGuest((int) ($claims['uid'] ?? 0), (string) ($claims['name'] ?? ''));
    }

    /**
     * Why this token can't be used now, or null. `$early` / `$late` apply a
     * guest's join window: the join itself checks both, the lobby and the
     * consent only the end (so an early guest can get ready), the heartbeat
     * and a renewal by a guest in the call only the start (a call that runs
     * over keeps its guests) — and never past {@see guestRenewsUntil()}.
     *
     * @param array{role:string} $claims
     * @param array<string,mixed>|null $guest {@see guestFor()}
     * @return array{0:int, 1:string, 2:array<string,mixed>}|null
     */
    public static function problem(
        Appointment $appointment,
        array $claims,
        ?array $guest,
        DateTimeImmutable $now,
        bool $early = true,
        bool $late = true,
    ): ?array {
        $status = $appointment->getStatus();
        if ($status === AppointmentStatus::CANCELLED) {
            return self::refusal(410, self::CANCELLED, 'cancelled');
        }
        if ($status === AppointmentStatus::COMPLETED) {
            return self::refusal(410, self::ENDED, 'ended');
        }
        if ($status === AppointmentStatus::PROPOSED) {
            return self::refusal(409, self::NOT_YET, 'not_confirmed', ['status' => 'proposed']);
        }
        if (($claims['role'] ?? '') !== 'guest') {
            return null;
        }
        if ($guest === null) {
            return self::refusal(410, self::WITHDRAWN, 'withdrawn');
        }
        if ($now > ($late ? self::guestClosesAt($appointment) : self::guestRenewsUntil($appointment))) {
            return self::refusal(410, self::ENDED, 'ended');
        }
        $opensAt = self::guestOpensAt($appointment);
        if ($early && $now < $opensAt) {
            $message = sprintf(
                "This consultation hasn't started yet. You can join from %s.",
                $opensAt->setTimezone(ClinicTime::zone())->format('D j M, g:i A T'),
            );

            return self::refusal(425, $message, 'too_early', [
                'starts_at'   => $appointment->getScheduledAt()->format(DATE_ATOM),
                'opens_at'    => $opensAt->format(DATE_ATOM),
                'server_time' => $now->format(DATE_ATOM),
            ]);
        }

        return null;
    }

    /** The Agora uid this token joins as: a guest's own stable uid, otherwise the token's. */
    public static function uidFor(array $claims, ?array $guest): int
    {
        return $guest !== null ? (int) ($guest['uid'] ?? 0) : (int) ($claims['uid'] ?? 0);
    }

    /**
     * Everyone who may be in the call, so each client can label a tile by its
     * Agora uid: the patient (uid 1), the doctor (uid 2), then each guest
     * (their own uid, `id` and whether they accepted the recording + privacy
     * notice). Names only — never an email.
     *
     * @return list<array{uid:int, role:string, name:string, id?:string, consented?:bool}>
     */
    public static function participants(Appointment $appointment): array
    {
        $p    = $appointment->getPatient()->toArray();
        $list = [
            [
                'uid'  => Appointment::PATIENT_UID,
                'role' => 'patient',
                'name' => trim(((string) ($p['first_name'] ?? '')) . ' ' . ((string) ($p['last_name'] ?? ''))) ?: 'Patient',
            ],
            ['uid' => Appointment::DOCTOR_UID, 'role' => 'doctor', 'name' => $appointment->getSpecialist()->getName()],
        ];
        foreach ($appointment->getGuests() as $guest) {
            if (!isset($guest['id'], $guest['uid'])) {
                continue; // not given an identity yet (bin/prod-migrate.php)
            }
            $list[] = [
                'uid'       => (int) $guest['uid'],
                'role'      => 'guest',
                'name'      => Appointment::guestDisplayName($guest),
                'id'        => (string) $guest['id'],
                'consented' => ($guest['consented_at'] ?? null) !== null,
            ];
        }

        return $list;
    }

    /** A timestamp kept on a guest entry (ATOM), or null when unset or unreadable. */
    private static function guestTime(array $guest, string $field): ?DateTimeImmutable
    {
        $value = $guest[$field] ?? null;
        if (!is_string($value) || $value === '') {
            return null;
        }
        try {
            return new DateTimeImmutable($value);
        } catch (\Exception) {
            return null;
        }
    }

    /**
     * @param array<string,mixed> $extra
     * @return array{0:int, 1:string, 2:array<string,mixed>}
     */
    private static function refusal(int $status, string $message, string $code, array $extra = []): array
    {
        return [$status, $message, ['call' => $message, 'code' => $code] + $extra];
    }
}
