<?php

declare(strict_types=1);

namespace App\Infrastructure\Availability;

use App\Domain\Settings\TimeZones;
use DateTimeImmutable;
use DateTimeZone;

/**
 * A doctor's "add availability" request expanded into concrete times — pure.
 *
 * Repeats: once ('none'), every day ('daily', Mon–Sun), on the start date's
 * weekday ('weekly'), or on chosen weekdays ('days', 0=Sun … 6=Sat), for 1–26
 * weeks from the start date. Each chosen local date gets [start, end) wall
 * clock in the doctor's zone, cut into `duration`-minute times by elapsed
 * stepping — so "09:00 every day" stays 09:00 local across a DST change, a
 * start inside a spring-forward gap rolls forward, and a fall-back night keeps
 * distinct instants. An end of 1440 ("24:00") is the next local midnight; an
 * overnight shift is two requests on two days.
 */
final class AvailabilitySeries
{
    public const MAX_SLOTS = 4000;
    public const MAX_WEEKS = 26;
    public const DEFAULT_WEEKS = 8;

    public const REPEATS = ['none', 'daily', 'weekly', 'days'];

    /**
     * The times of a request: [start, end) unix seconds, ascending.
     *
     * @param list<int> $weekdays 0..6 (the dates that take part); $endMin may be 1440 (midnight)
     * @return list<array{0:int,1:int}>
     * @throws AvailabilitySeriesException no times at all (`date`), or more than {@see MAX_SLOTS} (`end`)
     */
    public static function expand(
        string $firstYmd,
        int $startMin,
        int $endMin,
        int $durationMin,
        array $weekdays,
        int $weeks,
        DateTimeZone $tz,
    ): array {
        $weeks = max(1, $weeks);
        $step  = max(1, $durationMin) * 60;
        $want  = array_fill_keys(array_map('intval', $weekdays), true);
        $last  = BookingFrame::addDays($firstYmd, $weeks * 7 - 1);
        $n     = BookingFrame::daysBetween($firstYmd, $last);

        $out = [];
        for ($i = 0; $i <= $n; $i++) {
            $ymd = BookingFrame::addDays($firstYmd, $i);
            if (!isset($want[self::weekday($ymd)])) {
                continue;
            }
            $s = TimeZones::wallToInstant($ymd, $startMin, $tz);
            $e = TimeZones::wallToInstant($ymd, $endMin, $tz);
            for ($at = $s; $at + $step <= $e; $at += $step) {
                $out[] = [$at, $at + $step];
                if (count($out) > self::MAX_SLOTS) {
                    // Count them all for the message, without keeping them.
                    $total = self::count($firstYmd, $startMin, $endMin, $durationMin, $weekdays, $weeks, $tz);
                    throw AvailabilitySeriesException::tooMany($total);
                }
            }
        }
        if ($out === []) {
            throw AvailabilitySeriesException::none();
        }

        return $out;
    }

    /**
     * Split off the times already gone at $now (a start before the current
     * minute — one starting this very minute still counts as now).
     *
     * @param list<array{0:int,1:int}> $times
     * @return array{0: list<array{0:int,1:int}>, 1: int} [kept, how many were dropped]
     */
    public static function dropPast(array $times, DateTimeImmutable $now): array
    {
        $minute = $now->getTimestamp() - $now->getTimestamp() % 60;
        $kept   = array_values(array_filter($times, static fn (array $t): bool => $t[0] >= $minute));

        return [$kept, count($times) - count($kept)];
    }

    /** The weekday (0=Sun … 6=Sat) of a local date string — never of an instant. */
    public static function weekday(string $ymd): int
    {
        return (int) (new DateTimeImmutable($ymd . ' 12:00', new DateTimeZone('UTC')))->format('w');
    }

    /**
     * The weekdays a repeat covers: 'none' and 'weekly' the start date's,
     * 'daily' all seven, 'days' the chosen ones.
     *
     * @param list<int> $days
     * @return list<int>
     */
    public static function weekdaysFor(string $repeat, string $firstYmd, array $days = []): array
    {
        return match ($repeat) {
            'daily' => [0, 1, 2, 3, 4, 5, 6],
            'days'  => array_values(array_unique(array_map('intval', $days))),
            default => [self::weekday($firstYmd)],
        };
    }

    /** The last local date a request can reach ('none': the start date). */
    public static function lastDate(string $firstYmd, string $repeat, int $weeks): string
    {
        return $repeat === 'none' ? $firstYmd : BookingFrame::addDays($firstYmd, max(1, $weeks) * 7 - 1);
    }

    /**
     * Read the repeat options of a request body. `repeat` wins; without it the
     * legacy `recurring: true` means weekly (weeks clamped to 1–26, as before);
     * otherwise once.
     *
     * @param array<string,mixed> $body
     * @return array{repeat:string, weeks:int, days:list<int>, errors:array<string,string>}
     */
    public static function options(array $body): array
    {
        $errors = [];
        $days   = [];
        if (array_key_exists('repeat', $body) && $body['repeat'] !== null) {
            $repeat = is_string($body['repeat']) ? $body['repeat'] : '';
            if (!in_array($repeat, self::REPEATS, true)) {
                return ['repeat' => 'none', 'weeks' => 1, 'days' => [], 'errors' => ['repeat' => 'Choose how often it repeats']];
            }
            $weeks = 1;
            if ($repeat !== 'none') {
                $raw   = $body['weeks'] ?? self::DEFAULT_WEEKS;
                $weeks = self::wholeNumber($raw);
                if ($weeks === null || $weeks < 1 || $weeks > self::MAX_WEEKS) {
                    $errors['weeks'] = 'Choose 1 to 26 weeks';
                    $weeks = 1;
                }
            }
            if ($repeat === 'days') {
                $raw = $body['days'] ?? null;
                $ok  = is_array($raw) && $raw !== [];
                foreach (is_array($raw) ? $raw : [] as $d) {
                    $v = self::wholeNumber($d);
                    if ($v === null || $v < 0 || $v > 6) {
                        $ok = false;
                        break;
                    }
                    $days[$v] = $v;
                }
                if (!$ok) {
                    $errors['days'] = 'Choose at least one day';
                    $days = [];
                }
                sort($days);
                $days = array_values($days);
            }
        } elseif ((bool) ($body['recurring'] ?? false)) {
            $repeat = 'weekly';
            $weeks  = max(1, min(self::MAX_WEEKS, (int) ($body['weeks'] ?? self::DEFAULT_WEEKS)));
        } else {
            $repeat = 'none';
            $weeks  = 1;
        }

        return ['repeat' => $repeat, 'weeks' => $weeks, 'days' => $days, 'errors' => $errors];
    }

    /** How many times a request would make (for the too-many message). @param list<int> $weekdays */
    private static function count(string $firstYmd, int $startMin, int $endMin, int $durationMin, array $weekdays, int $weeks, DateTimeZone $tz): int
    {
        $step  = max(1, $durationMin) * 60;
        $want  = array_fill_keys(array_map('intval', $weekdays), true);
        $n     = max(1, $weeks) * 7 - 1;
        $total = 0;
        for ($i = 0; $i <= $n; $i++) {
            $ymd = BookingFrame::addDays($firstYmd, $i);
            if (isset($want[self::weekday($ymd)])) {
                $span   = TimeZones::wallToInstant($ymd, $endMin, $tz) - TimeZones::wallToInstant($ymd, $startMin, $tz);
                $total += $span >= $step ? intdiv($span, $step) : 0;
            }
        }

        return $total;
    }

    /** An int, or an integral numeric string ("8"), else null. */
    private static function wholeNumber(mixed $v): ?int
    {
        if (is_int($v)) {
            return $v;
        }
        if (is_string($v) && preg_match('/^\d{1,3}$/', trim($v)) === 1) {
            return (int) trim($v);
        }
        if (is_float($v) && floor($v) === $v && abs($v) < 1000) {
            return (int) $v;
        }

        return null;
    }
}
