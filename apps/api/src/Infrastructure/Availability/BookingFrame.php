<?php

declare(strict_types=1);

namespace App\Infrastructure\Availability;

use App\Domain\Settings\ClinicTime;
use DateTimeImmutable;
use DateTimeZone;

/**
 * "Now", seen from one time zone: the calendar days a patient picks from and the
 * bookable window, both fixed for the length of a request.
 *
 *   - Days are the zone's calendar days ('Y-m-d'), each a [start, end) span of
 *     unix seconds computed in the zone (so DST days are 23 or 25 hours long).
 *   - The bookable window is [now + lead, now + horizon) — instants, so it is
 *     the same whatever zone the viewer is in and the booking guard applies it
 *     exactly: `bookable_until` is the zone's date of the window's last second.
 *   - Parts of the day (local clock): morning 05–12, afternoon 12–17, evening
 *     from 17 — the small hours before 05 count as evening (the night before).
 *   - `enforceHorizon` false is the staff / doctor view: a year-long window
 *     instead of the patient horizon, and the doctor's bookings switch ignored
 *     (like the booking guard's staff paths).
 */
final class BookingFrame
{
    public const PARTS_OF_DAY = ['morning', 'afternoon', 'evening'];

    /** Today in the zone, 'Y-m-d'. */
    public readonly string $today;

    /** The earliest bookable instant (now + lead). */
    public readonly int $bookableFrom;

    /** The end of the bookable window (now + horizon), exclusive. */
    public readonly int $bookableUntil;

    /** The zone's date of the first and last bookable instants, 'Y-m-d'. */
    public readonly string $bookableFromDate;
    public readonly string $bookableUntilDate;

    public function __construct(
        public readonly DateTimeZone $tz,
        public readonly int $now,
        public readonly int $leadMinutes,
        public readonly int $horizonDays,
        public readonly bool $enforceHorizon = true,
    ) {
        $this->today             = $this->dateOf($now);
        $this->bookableFrom      = $now + $leadMinutes * 60;
        $this->bookableUntil     = $now + $horizonDays * 86400;
        $this->bookableFromDate  = $this->dateOf($this->bookableFrom);
        $this->bookableUntilDate = $this->dateOf($this->bookableUntil - 1);
    }

    /** A valid IANA zone name as a zone, else the clinic's ({@see ClinicTime}). */
    public static function zone(mixed $name): DateTimeZone
    {
        $name = is_string($name) ? trim($name) : '';
        if ($name !== '' && strlen($name) <= 64) {
            try {
                return new DateTimeZone($name);
            } catch (\Throwable) {
                // fall through to the clinic's zone
            }
        }

        return ClinicTime::zone();
    }

    /** Is $value a real calendar date written 'Y-m-d'? */
    public static function isYmd(mixed $value): bool
    {
        if (!is_string($value) || preg_match('/^\d{4}-\d{2}-\d{2}$/', $value) !== 1) {
            return false;
        }
        $d = DateTimeImmutable::createFromFormat('!Y-m-d', $value, new DateTimeZone('UTC'));

        return $d !== false && $d->format('Y-m-d') === $value;
    }

    /** 'Y-m-d' moved by $days calendar days (zone-free date arithmetic). */
    public static function addDays(string $ymd, int $days): string
    {
        return (new DateTimeImmutable($ymd, new DateTimeZone('UTC')))->modify(($days >= 0 ? '+' : '') . $days . ' days')->format('Y-m-d');
    }

    /** Whole calendar days from $from to $to (negative when $to is earlier). */
    public static function daysBetween(string $from, string $to): int
    {
        $utc = new DateTimeZone('UTC');

        return intdiv((new DateTimeImmutable($to, $utc))->getTimestamp() - (new DateTimeImmutable($from, $utc))->getTimestamp(), 86400);
    }

    /** Is $part one of the parts of the day? */
    public static function isPartOfDay(mixed $part): bool
    {
        return is_string($part) && in_array($part, self::PARTS_OF_DAY, true);
    }

    /** The zone's date of an instant, 'Y-m-d'. */
    public function dateOf(int $at): string
    {
        return (new DateTimeImmutable('@' . $at))->setTimezone($this->tz)->format('Y-m-d');
    }

    /** Can anything on $date still be booked (today … bookable_until)? */
    public function isBookableDate(string $date): bool
    {
        return $date >= $this->today && $date <= $this->bookableUntilDate;
    }

    /**
     * One calendar day in the zone: its span and its part-of-day boundaries.
     *
     * @return array{date:string, start:int, end:int, h5:int, h12:int, h17:int}
     */
    public function day(string $date): array
    {
        $at = fn (string $hm): int => (new DateTimeImmutable($date . ' ' . $hm, $this->tz))->getTimestamp();

        return [
            'date'  => $date,
            'start' => $at('00:00'),
            'end'   => (new DateTimeImmutable(self::addDays($date, 1) . ' 00:00', $this->tz))->getTimestamp(),
            'h5'    => $at('05:00'),
            'h12'   => $at('12:00'),
            'h17'   => $at('17:00'),
        ];
    }

    /**
     * The days $from … $to inclusive (empty when $to is before $from). Counted,
     * not compared as strings: "10000-01-01" sorts before "9999-12-31".
     *
     * @return list<array{date:string, start:int, end:int, h5:int, h12:int, h17:int}>
     */
    public function days(string $from, string $to): array
    {
        $out = [];
        $n   = self::daysBetween($from, $to);
        for ($i = 0; $i <= $n; $i++) {
            $out[] = $this->day(self::addDays($from, $i));
        }

        return $out;
    }

    /**
     * Which part of $day an instant on it falls in.
     *
     * @param array{h5:int, h12:int, h17:int} $day
     */
    public static function partOf(array $day, int $at): string
    {
        return match (true) {
            $at < $day['h5']  => 'evening',
            $at < $day['h12'] => 'morning',
            $at < $day['h17'] => 'afternoon',
            default           => 'evening',
        };
    }

    /**
     * A bookable time as the calendar shows it: the instant (ISO, UTC), the
     * zone's "HH:mm" and "9:30 AM", and its part of the day.
     *
     * @param array{h5:int, h12:int, h17:int} $day the day it falls on
     * @return array{iso:string, time:string, label:string, period:string}
     */
    public function slot(int $at, array $day): array
    {
        $local = (new DateTimeImmutable('@' . $at))->setTimezone($this->tz);

        return [
            'iso'    => self::iso($at),
            'time'   => $local->format('H:i'),
            'label'  => $local->format('g:i A'),
            'period' => self::partOf($day, $at),
        ];
    }

    /** "9:30 AM" on the zone's clock. */
    public function timeLabel(int $at): string
    {
        return (new DateTimeImmutable('@' . $at))->setTimezone($this->tz)->format('g:i A');
    }

    /** "Thu 16 Oct" on the zone's calendar. */
    public function dateLabel(int $at): string
    {
        return (new DateTimeImmutable('@' . $at))->setTimezone($this->tz)->format('D j M');
    }

    /** An instant as ISO 8601 in UTC, e.g. "2026-10-16T08:00:00+00:00". */
    public static function iso(int $at): string
    {
        return (new DateTimeImmutable('@' . $at))->format(DATE_ATOM);
    }
}
