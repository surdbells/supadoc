<?php

declare(strict_types=1);

namespace App\Domain\Doctor;

/**
 * A doctor's recurring weekly hours, as PATCH /doctor/profile accepts them:
 * weekday "0" (Sun) … "6" (Sat) → up to {@see MAX_WINDOWS} [start, end] "HH:MM"
 * windows on the doctor's own clock, earliest first, not overlapping; an end
 * may be "24:00" (midnight). Pure.
 */
final class WeeklyHours
{
    public const MAX_WINDOWS = 6;

    public const MESSAGE = "Enter each day's hours as start and end times, earliest first, without overlaps";

    private const START = '/^([01]\d|2[0-3]):[0-5]\d$/';

    /**
     * The hours to store — null clears them (an empty map) — or false when
     * they are malformed.
     *
     * @return array<string, list<array{0:string,1:string}>>|null|false
     */
    public static function normalize(mixed $hours): array|null|false
    {
        if ($hours === null || $hours === []) {
            return null;
        }
        if (!is_array($hours)) {
            return false;
        }
        $out = [];
        foreach ($hours as $day => $windows) {
            $key = (string) $day;
            if (preg_match('/^[0-6]$/', $key) !== 1 || !is_array($windows) || !array_is_list($windows) || count($windows) > self::MAX_WINDOWS) {
                return false;
            }
            $prevEnd = -1;
            $clean   = [];
            foreach ($windows as $w) {
                if (!is_array($w) || !array_is_list($w) || count($w) !== 2) {
                    return false;
                }
                [$s, $e] = [self::minutes($w[0], false), self::minutes($w[1], true)];
                if ($s === null || $e === null || $s >= $e || $s < $prevEnd) {
                    return false;
                }
                $prevEnd = $e;
                $clean[] = [trim((string) $w[0]), trim((string) $w[1])];
            }
            if ($clean !== []) {
                $out[$key] = $clean;
            }
        }
        ksort($out, SORT_STRING);

        return $out !== [] ? $out : null;
    }

    /** "HH:MM" as minutes since midnight ("24:00" only as an end), or null. */
    private static function minutes(mixed $hm, bool $end): ?int
    {
        if (!is_string($hm)) {
            return null;
        }
        $hm = trim($hm);
        if ($end && $hm === '24:00') {
            return 1440;
        }
        if (preg_match(self::START, $hm) !== 1) {
            return null;
        }

        return ((int) substr($hm, 0, 2)) * 60 + (int) substr($hm, 3, 2);
    }
}
