<?php

declare(strict_types=1);

namespace App\Domain\Document;

use App\Domain\Enum\AppointmentStatus;
use DateTimeImmutable;

/**
 * Whether a doctor may ask a patient to share documents now (spec §3.2),
 * from facts the caller read under the pair lock. Pure.
 *
 * Facts:
 *  - `appointment`: `{status: string, deleted: bool, ends_at: DateTimeImmutable}` of the
 *    consultation the request is made from, or null;
 *  - `practising`: the doctor is approved and not deleted;
 *  - `pending`: the pair has a pending request that has not expired;
 *  - `blocked`: the patient stopped this doctor asking (open block);
 *  - `has_folder` / `folder_ends_at`: an active whole-folder share and its end (null = no end);
 *  - `last_declined_at`: when the pair's last request was declined, or null;
 *  - `pair_requests`: when this doctor asked this patient in the last 30 days;
 *  - `doctor_requests`: when this doctor asked anyone in the last 24 hours.
 */
final class AccessRequestRules
{
    /** Consultations a request can be made from while open… */
    private const OPEN = ['pending', 'confirmed', 'rescheduled'];
    /** …or within 30 days of their end once closed. */
    private const CLOSED = ['completed', 'missed'];
    private const CLOSED_WINDOW_DAYS = 30;

    /**
     * Why a request can't be made now, as `{code, available_at}` (the instant
     * it may be made again, for a cooldown or a limit), or null when it may.
     *
     * @param array<string,mixed> $facts
     * @return array{code:string, available_at:?DateTimeImmutable}|null
     */
    public static function check(array $facts, DateTimeImmutable $now): ?array
    {
        if (!self::appointmentEligible($facts['appointment'] ?? null, $now)) {
            return ['code' => 'appointment_not_eligible', 'available_at' => null];
        }
        if (!($facts['practising'] ?? true)) {
            return ['code' => 'doctor_unavailable', 'available_at' => null];
        }
        if ($facts['pending'] ?? false) {
            return ['code' => 'request_pending', 'available_at' => null];
        }
        if ($facts['blocked'] ?? false) {
            return ['code' => 'request_blocked', 'available_at' => null];
        }
        if (self::hasFullAccess($facts, $now)) {
            return ['code' => 'has_full_access', 'available_at' => null];
        }
        $declined = $facts['last_declined_at'] ?? null;
        if ($declined instanceof DateTimeImmutable) {
            $again = $declined->modify('+' . DocumentSharingRules::DECLINE_COOLDOWN_HOURS . ' hours');
            if ($again > $now) {
                return ['code' => 'request_cooldown', 'available_at' => $again];
            }
        }
        $limit = self::limitAvailableAt($facts['pair_requests'] ?? [], $now, DocumentSharingRules::PAIR_REQUESTS_30D, '30 days');
        $daily = self::limitAvailableAt($facts['doctor_requests'] ?? [], $now, DocumentSharingRules::DOCTOR_REQUESTS_24H, '24 hours');
        if ($limit !== null || $daily !== null) {
            return ['code' => 'request_limit', 'available_at' => max(array_filter([$limit, $daily]))];
        }

        return null;
    }

    /** What a new request would be: `extend` while a whole-folder share ends within 48 hours, else `access`. */
    public static function kind(array $facts, DateTimeImmutable $now): string
    {
        $ends = $facts['folder_ends_at'] ?? null;

        return ($facts['has_folder'] ?? false) && $ends instanceof DateTimeImmutable && !self::hasFullAccess($facts, $now)
            ? 'extend'
            : 'access';
    }

    /** An active whole-folder share whose end is NULL or more than 48 hours away. */
    public static function hasFullAccess(array $facts, DateTimeImmutable $now): bool
    {
        if (!($facts['has_folder'] ?? false)) {
            return false;
        }
        $ends = $facts['folder_ends_at'] ?? null;

        return !$ends instanceof DateTimeImmutable
            || $ends > $now->modify('+' . DocumentSharingRules::EXTEND_WINDOW_HOURS . ' hours');
    }

    /**
     * A request may be made from the doctor's consultation with this patient
     * that is not deleted and open (pending, confirmed, rescheduled), or
     * completed / missed and ended at most 30 days ago.
     *
     * @param array{status:string, deleted:bool, ends_at:DateTimeImmutable}|null $appointment
     */
    public static function appointmentEligible(?array $appointment, DateTimeImmutable $now): bool
    {
        if ($appointment === null || ($appointment['deleted'] ?? true)) {
            return false;
        }
        $status = $appointment['status'] instanceof AppointmentStatus ? $appointment['status']->value : (string) $appointment['status'];
        if (in_array($status, self::OPEN, true)) {
            return true;
        }
        $ends = $appointment['ends_at'] ?? null;

        return in_array($status, self::CLOSED, true)
            && $ends instanceof DateTimeImmutable
            && $ends >= $now->modify('-' . self::CLOSED_WINDOW_DAYS . ' days');
    }

    /**
     * When a rolling limit of `$max` per `$window` frees up again, or null
     * while it isn't reached. `$times` are the requests counted.
     *
     * @param list<DateTimeImmutable> $times
     */
    private static function limitAvailableAt(array $times, DateTimeImmutable $now, int $max, string $window): ?DateTimeImmutable
    {
        $since  = $now->modify('-' . $window);
        $inside = array_values(array_filter($times, static fn ($t): bool => $t instanceof DateTimeImmutable && $t > $since && $t <= $now));
        if (count($inside) < $max) {
            return null;
        }
        usort($inside, static fn (DateTimeImmutable $a, DateTimeImmutable $b): int => $a <=> $b);

        // The request that has to fall out of the window for the count to drop below the limit.
        return $inside[count($inside) - $max]->modify('+' . $window);
    }
}
