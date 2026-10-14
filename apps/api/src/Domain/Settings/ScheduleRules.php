<?php

declare(strict_types=1);

namespace App\Domain\Settings;

use DateTimeImmutable;
use DateTimeZone;

/**
 * "Calendars start from now" — the shared past-date rules behind the doctor's
 * availability editor and medical certificates.
 *
 * Availability dates and times are UTC wall-clock (the editor's convention), so
 * those checks compare instants, to the minute: a start typed as the current
 * "HH:MM" still counts as now. The certificate backdate is a date-only rule on
 * the clinic's calendar ({@see ClinicTime}).
 */
final class ScheduleRules
{
    /** How far back sick leave may start — a short backdate is clinically valid. */
    public const CERTIFICATE_BACKDATE_DAYS = 7;

    /** Has $start already gone by (before the current minute)? */
    public static function hasPassed(DateTimeImmutable $start, ?DateTimeImmutable $now = null): bool
    {
        $now ??= new DateTimeImmutable('now', new DateTimeZone('UTC'));
        $minute = $now->setTime((int) $now->format('H'), (int) $now->format('i'));

        return $start < $minute;
    }

    /** Is the UTC calendar day $date (any time on it) before today, UTC? */
    public static function isPastUtcDay(DateTimeImmutable $date, ?DateTimeImmutable $now = null): bool
    {
        $utc = new DateTimeZone('UTC');
        $now ??= new DateTimeImmutable('now', $utc);

        return $date->setTimezone($utc)->format('Y-m-d') < $now->setTimezone($utc)->format('Y-m-d');
    }

    /** The earliest date a sick-leave certificate may start, Y-m-d on the clinic's calendar. */
    public static function earliestCertificateStart(?string $todayYmd = null): string
    {
        return (new DateTimeImmutable($todayYmd ?? ClinicTime::todayYmd()))
            ->modify('-' . self::CERTIFICATE_BACKDATE_DAYS . ' days')
            ->format('Y-m-d');
    }

    /** Does $from start further back than the certificate backdate allows? */
    public static function isCertificateBackdatedTooFar(DateTimeImmutable $from, ?string $todayYmd = null): bool
    {
        return $from->format('Y-m-d') < self::earliestCertificateStart($todayYmd);
    }

    /**
     * The backdate window as the certificates list exposes it (`meta`), so the
     * doctor's date picker uses the clinic calendar, not the browser's. The POST
     * still re-checks — this is a hint, never the authority.
     *
     * @return array{earliest_from_date: string, backdate_days: int}
     */
    public static function certificateWindow(?string $todayYmd = null): array
    {
        return [
            'earliest_from_date' => self::earliestCertificateStart($todayYmd),
            'backdate_days'      => self::CERTIFICATE_BACKDATE_DAYS,
        ];
    }

    /**
     * How many whole `$duration`-minute slots fit in [$start, $end) (minutes of
     * the day). 0 means the range is too short to publish anything.
     */
    public static function slotsInRange(int $start, int $end, int $duration): int
    {
        if ($duration <= 0 || $end <= $start) {
            return 0;
        }

        return intdiv($end - $start, $duration);
    }
}
