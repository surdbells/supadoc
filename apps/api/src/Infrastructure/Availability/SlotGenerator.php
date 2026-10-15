<?php

declare(strict_types=1);

namespace App\Infrastructure\Availability;

/**
 * The one place consultation times are made — pure, so the calendar, the
 * directory, the suggestions and the booking guard can't disagree.
 *
 * Per UTC day (the doctor editor's day): a day on which the doctor published
 * explicit open slots offers exactly those; any other day offers the weekly
 * grid for its weekday, stepped by the doctor's own consultation length (a
 * consult must end inside its window). Each candidate then gets a state:
 *
 *   early   — starts before the lead time (too soon to book)
 *   late    — starts at or after the booking horizon (when one is given)
 *   blocked — overlaps a block the doctor set
 *   taken   — overlaps a live appointment, which lasts as long as the explicit
 *             slot it started on, else the doctor's consultation length
 *   open    — bookable
 */
final class SlotGenerator
{
    public const OPEN    = 'open';
    public const TAKEN   = 'taken';
    public const BLOCKED = 'blocked';
    public const EARLY   = 'early';
    public const LATE    = 'late';

    private const DAY = 86400;

    /**
     * Every candidate start in [$from, $to) (unix seconds), soonest first.
     *
     * @return list<array{start:int, end:int, state:string}>
     */
    public static function generate(
        Schedule $schedule,
        int $from,
        int $to,
        int $bookableFrom,
        ?int $bookableUntil = null,
    ): array {
        if ($to <= $from) {
            return [];
        }
        $step = max(1, $schedule->slotMinutes) * 60;

        // Explicit open slots by UTC day, and how long each one runs (for the
        // length of an appointment booked on it).
        $explicitByDay = [];
        $explicitLength = [];
        foreach ($schedule->openSlots as [$start, $end]) {
            if ($end <= $start) {
                continue;
            }
            $explicitByDay[intdiv($start, self::DAY)][] = [$start, $end];
            $explicitLength[$start] = max($explicitLength[$start] ?? 0, $end - $start);
        }

        /** @var array<int, array{0:int,1:int}> $candidates keyed by start: one candidate per start */
        $candidates = [];
        for ($day = intdiv($from, self::DAY); $day * self::DAY < $to; $day++) {
            if (isset($explicitByDay[$day])) {
                foreach ($explicitByDay[$day] as [$start, $end]) {
                    if ($start >= $from && $start < $to) {
                        $candidates[$start] ??= [$start, $end];
                    }
                }
                continue;
            }
            $dayStart = $day * self::DAY;
            foreach ($schedule->weeklyHours[gmdate('w', $dayStart)] ?? [] as $window) {
                $open  = self::minutes($window[0] ?? null);
                $close = self::minutes($window[1] ?? null);
                if ($open === null || $close === null) {
                    continue;
                }
                $stop = $dayStart + $close * 60;
                for ($at = $dayStart + $open * 60; $at + $step <= $stop; $at += $step) {
                    if ($at >= $from && $at < $to) {
                        $candidates[$at] ??= [$at, $at + $step];
                    }
                }
            }
        }
        ksort($candidates);

        $booked = [];
        foreach ($schedule->booked as $start) {
            $booked[] = [$start, $start + ($explicitLength[$start] ?? $step)];
        }

        $out = [];
        foreach ($candidates as [$start, $end]) {
            $out[] = ['start' => $start, 'end' => $end, 'state' => match (true) {
                $start < $bookableFrom                                => self::EARLY,
                $bookableUntil !== null && $start >= $bookableUntil   => self::LATE,
                self::overlapsAny($start, $end, $schedule->blocks)    => self::BLOCKED,
                self::overlapsAny($start, $end, $booked)              => self::TAKEN,
                default                                               => self::OPEN,
            }];
        }

        return $out;
    }

    /** Is a consultation at exactly $at open (the booking guard — same rules as {@see generate()})? */
    public static function isOpenAt(Schedule $schedule, int $at, int $bookableFrom, ?int $bookableUntil = null): bool
    {
        foreach (self::generate($schedule, $at, $at + 1, $bookableFrom, $bookableUntil) as $candidate) {
            if ($candidate['start'] === $at) {
                return $candidate['state'] === self::OPEN;
            }
        }

        return false;
    }

    /** @param list<array{0:int,1:int}> $spans */
    private static function overlapsAny(int $start, int $end, array $spans): bool
    {
        foreach ($spans as [$from, $to]) {
            if ($start < $to && $end > $from) {
                return true;
            }
        }

        return false;
    }

    /** "HH:MM" (up to "24:00") as minutes since midnight, or null when malformed. */
    private static function minutes(mixed $hm): ?int
    {
        if (!is_string($hm) || preg_match('/^(\d{1,2}):([0-5]\d)$/', trim($hm), $m) !== 1) {
            return null;
        }
        $minutes = ((int) $m[1]) * 60 + (int) $m[2];

        return $minutes <= 1440 ? $minutes : null;
    }
}
