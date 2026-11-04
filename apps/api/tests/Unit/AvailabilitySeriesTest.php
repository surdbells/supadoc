<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Infrastructure\Availability\AvailabilitySeries as Series;
use App\Infrastructure\Availability\AvailabilitySeriesException;
use App\Infrastructure\Availability\SpanIndex;
use DateTimeImmutable;
use DateTimeZone;
use PHPUnit\Framework\TestCase;

/**
 * A doctor's "add availability" request expanded into times: every day, the
 * start date's weekday, or chosen weekdays, for 1–26 weeks, as wall clock in
 * the doctor's zone — DST-safe, midnight-ending, and capped.
 */
final class AvailabilitySeriesTest extends TestCase
{
    private static function z(string $name): DateTimeZone
    {
        return new DateTimeZone($name);
    }

    /** @param list<array{0:int,1:int}> $spans @return list<string> starts as "Y-m-d H:i" in $tz */
    private static function local(array $spans, string $tz): array
    {
        return array_map(static fn (array $s): string => (new DateTimeImmutable('@' . $s[0]))->setTimezone(self::z($tz))->format('Y-m-d H:i'), $spans);
    }

    public function testDailyForOneWeekIsSevenDaysOfTimes(): void
    {
        // Mon 9 Nov 2026, 09:00–12:00 at 30 min: 6 a day.
        $out = Series::expand('2026-11-09', 540, 720, 30, Series::weekdaysFor('daily', '2026-11-09'), 1, self::z('Africa/Lagos'));
        $this->assertCount(7 * 6, $out);
        $this->assertSame('2026-11-09 09:00', self::local($out, 'Africa/Lagos')[0]);
        $this->assertSame('2026-11-15 11:30', self::local($out, 'Africa/Lagos')[41]);
        $this->assertSame((new DateTimeImmutable('2026-11-09T08:00:00Z'))->getTimestamp(), $out[0][0], 'Lagos 09:00 is 08:00Z');
        $this->assertSame($out[0][0] + 1800, $out[0][1]);
    }

    public function testTheSpecExampleIs336TimesInChicago(): void
    {
        $out = Series::expand('2026-11-09', 540, 720, 30, Series::weekdaysFor('daily', '2026-11-09'), 8, self::z('America/Chicago'));
        $this->assertCount(336, $out);
        $this->assertSame('2026-11-09T15:00:00+00:00', (new DateTimeImmutable('@' . $out[0][0]))->format(DATE_ATOM));
        $this->assertSame('2027-01-03T17:30:00+00:00', (new DateTimeImmutable('@' . $out[335][0]))->format(DATE_ATOM));
    }

    public function testChosenDaysAndWeekly(): void
    {
        // Mon/Wed/Fri for 2 weeks from Mon 9 Nov: 6 days.
        $out  = Series::expand('2026-11-09', 540, 600, 60, Series::weekdaysFor('days', '2026-11-09', [1, 3, 5]), 2, self::z('Africa/Lagos'));
        $days = array_map(static fn (string $s): string => substr($s, 0, 10), self::local($out, 'Africa/Lagos'));
        $this->assertSame(['2026-11-09', '2026-11-11', '2026-11-13', '2026-11-16', '2026-11-18', '2026-11-20'], $days);

        // Weekly: the start date's weekday only (Wed 11 Nov).
        $out  = Series::expand('2026-11-11', 540, 600, 60, Series::weekdaysFor('weekly', '2026-11-11'), 3, self::z('Africa/Lagos'));
        $this->assertSame(['2026-11-11 09:00', '2026-11-18 09:00', '2026-11-25 09:00'], self::local($out, 'Africa/Lagos'));
        $this->assertSame([3], Series::weekdaysFor('none', '2026-11-11'));
        $this->assertSame(3, Series::weekday('2026-11-11'), 'from the date string, never an instant');
    }

    public function testRepeatOptionsAndTheLegacyRecurringFlag(): void
    {
        $this->assertSame(['repeat' => 'weekly', 'weeks' => 3, 'days' => [], 'errors' => []], Series::options(['recurring' => true, 'weeks' => 3]));
        $this->assertSame(26, Series::options(['recurring' => true, 'weeks' => 99])['weeks'], 'legacy clamps, as before');
        $this->assertSame(['repeat' => 'none', 'weeks' => 1, 'days' => [], 'errors' => []], Series::options([]));
        $this->assertSame(8, Series::options(['repeat' => 'daily'])['weeks'], 'default 8 weeks');
        $this->assertSame([1, 3, 5], Series::options(['repeat' => 'days', 'days' => [5, 1, 3, 3], 'weeks' => '2'])['days']);
        $this->assertSame(['repeat' => 'Choose how often it repeats'], Series::options(['repeat' => 'hourly'])['errors']);
        $this->assertSame(['days' => 'Choose at least one day'], Series::options(['repeat' => 'days', 'days' => []])['errors']);
        $this->assertSame(['days' => 'Choose at least one day'], Series::options(['repeat' => 'days', 'days' => [7]])['errors']);
        foreach ([0, 27, '', 'x', 2.5] as $weeks) {
            $this->assertSame(['weeks' => 'Choose 1 to 26 weeks'], Series::options(['repeat' => 'weekly', 'weeks' => $weeks])['errors'], var_export($weeks, true));
        }

        // Legacy weekly × 3 expands like `weekly`.
        $legacy = Series::options(['recurring' => true, 'weeks' => 3]);
        $out    = Series::expand('2026-11-09', 540, 600, 60, Series::weekdaysFor($legacy['repeat'], '2026-11-09'), $legacy['weeks'], self::z('UTC'));
        $this->assertSame(['2026-11-09 09:00', '2026-11-16 09:00', '2026-11-23 09:00'], self::local($out, 'UTC'));
        $this->assertSame('2026-11-29', Series::lastDate('2026-11-09', 'weekly', 3));
        $this->assertSame('2026-11-09', Series::lastDate('2026-11-09', 'none', 8));
    }

    public function testNoTimesAndTooManyTimesAreRefused(): void
    {
        foreach ([[[], 540, 600], [[1], 540, 560]] as [$weekdays, $start, $end]) {
            try {
                // No chosen weekday at all, or a range too short for one time.
                Series::expand('2026-11-09', $start, $end, 30, $weekdays, 1, self::z('UTC'));
                $this->fail('no times');
            } catch (AvailabilitySeriesException $e) {
                $this->assertSame('date', $e->field);
                $this->assertSame('None of the chosen days fall in this period', $e->getMessage());
            }
        }

        try {
            // Daily 07:00–21:00 at 15 min for 26 weeks: 56 × 182.
            Series::expand('2026-11-09', 420, 1260, 15, Series::weekdaysFor('daily', '2026-11-09'), 26, self::z('Africa/Lagos'));
            $this->fail('too many');
        } catch (AvailabilitySeriesException $e) {
            $this->assertSame('end', $e->field);
            $this->assertSame(10192, $e->total);
            $this->assertSame('That adds 10,192 times — the most at once is 4,000. Choose fewer weeks or a shorter time range.', $e->getMessage());
        }

        // Under the cap is fine: 24 a day for 23 weeks is 3,864.
        $this->assertCount(24 * 7 * 23, Series::expand('2026-11-09', 0, 1440, 60, [0, 1, 2, 3, 4, 5, 6], 23, self::z('UTC')));
    }

    public function testASeriesStartingTodayDropsTimesAlreadyGone(): void
    {
        $tz  = self::z('Africa/Lagos');
        $out = Series::expand('2026-11-09', 540, 720, 30, Series::weekdaysFor('daily', '2026-11-09'), 1, $tz);
        // 10:15 WAT on the first day: 09:00, 09:30 and 10:00 have gone (to the minute).
        [$kept, $past] = Series::dropPast($out, new DateTimeImmutable('2026-11-09T09:15:40Z'));
        $this->assertSame(3, $past);
        $this->assertCount(42 - 3, $kept);
        $this->assertSame('2026-11-09 10:30', self::local($kept, 'Africa/Lagos')[0]);
        // A time starting this very minute still counts as now.
        [$kept, $past] = Series::dropPast($out, new DateTimeImmutable('2026-11-09T08:00:59Z'));
        $this->assertSame(0, $past);
        $this->assertCount(42, $kept);
    }

    public function testDaylightSavingKeepsTheWallClock(): void
    {
        // New York, daily 09:00 across the 2027-03-14 spring forward: 14:00Z, then 13:00Z.
        $out = Series::expand('2027-03-13', 540, 600, 60, Series::weekdaysFor('daily', '2027-03-13'), 1, self::z('America/New_York'));
        $this->assertSame('2027-03-13T14:00:00+00:00', (new DateTimeImmutable('@' . $out[0][0]))->format(DATE_ATOM));
        $this->assertSame('2027-03-14T13:00:00+00:00', (new DateTimeImmutable('@' . $out[1][0]))->format(DATE_ATOM));
        $this->assertSame(array_fill(0, 7, '09:00'), array_map(static fn (string $s): string => substr($s, 11), self::local($out, 'America/New_York')));

        // Chicago 2027-03-13 09:00 CST is 15:00Z; 2027-03-14 09:00 CDT is 14:00Z.
        $out = Series::expand('2027-03-13', 540, 570, 30, Series::weekdaysFor('daily', '2027-03-13'), 1, self::z('America/Chicago'));
        $this->assertSame([(new DateTimeImmutable('2027-03-13T15:00:00Z'))->getTimestamp(), (new DateTimeImmutable('2027-03-14T14:00:00Z'))->getTimestamp()], [$out[0][0], $out[1][0]]);
    }

    public function testAFallBackNightKeepsDistinctInstants(): void
    {
        // Chicago 2027-11-07 00:00–03:00 at 30 min: 4 elapsed hours → 8 times; 01:00 and 01:30 twice.
        $out = Series::expand('2027-11-07', 0, 180, 30, [0], 1, self::z('America/Chicago'));
        $this->assertCount(8, $out);
        $starts = array_column($out, 0);
        $this->assertSame($starts, array_values(array_unique($starts)), 'distinct instants');
        $this->assertSame(['00:00', '00:30', '01:00', '01:30', '01:00', '01:30', '02:00', '02:30'], array_map(static fn (string $s): string => substr($s, 11), self::local($out, 'America/Chicago')));

        // London 2026-10-25 01:00–02:00: from the FIRST 01:00 (BST, 00:00Z) to 02:00 GMT —
        // both runs of the repeated hour, as in Chicago (PHP alone would start at 01:00 GMT).
        $out = Series::expand('2026-10-25', 60, 120, 30, [0], 1, self::z('Europe/London'));
        $this->assertSame(
            ['2026-10-25T00:00:00+00:00', '2026-10-25T00:30:00+00:00', '2026-10-25T01:00:00+00:00', '2026-10-25T01:30:00+00:00'],
            array_map(static fn (array $s): string => (new DateTimeImmutable('@' . $s[0]))->format(DATE_ATOM), $out),
        );
    }

    public function testASpringForwardWindowGivesFewerTimes(): void
    {
        // Chicago 2027-03-14 01:00–04:00 at 30 min: 01:00 01:30 03:00 03:30 (2 real hours).
        $out = Series::expand('2027-03-14', 60, 240, 30, [0], 1, self::z('America/Chicago'));
        $this->assertSame(['01:00', '01:30', '03:00', '03:30'], array_map(static fn (string $s): string => substr($s, 11), self::local($out, 'America/Chicago')));
    }

    public function testAMidnightEndRunsToTheNextLocalMidnight(): void
    {
        $out = Series::expand('2026-11-09', 1260, 1440, 60, [1], 1, self::z('Africa/Lagos'));
        $this->assertCount(3, $out);
        $this->assertSame((new DateTimeImmutable('2026-11-09T23:00:00Z'))->getTimestamp(), $out[2][1], 'the last ends at Lagos midnight');

        // 21:00–24:00 on the 2027-11-07 fall-back night still ends at the next local midnight.
        $out = Series::expand('2027-11-07', 1260, 1440, 60, [0], 1, self::z('America/Chicago'));
        $this->assertCount(3, $out);
        $this->assertSame((new DateTimeImmutable('2027-11-08T06:00:00Z'))->getTimestamp(), $out[2][1]);
    }

    public function testTheSpanIndexFindsOverlapsLikeALinearScan(): void
    {
        $spans = [[100, 200], [150, 160], [500, 900], [1000, 1001]];
        $index = SpanIndex::of($spans);
        foreach ([[0, 100], [0, 101], [199, 300], [200, 500], [880, 950], [901, 999], [1000, 1001], [1001, 1100], [160, 170]] as [$s, $e]) {
            $linear = false;
            foreach ($spans as [$a, $b]) {
                $linear = $linear || ($s < $b && $e > $a);
            }
            $this->assertSame($linear, $index->overlaps($s, $e), "[{$s}, {$e})");
        }
        $this->assertFalse(SpanIndex::of([])->overlaps(0, 10));
    }
}
