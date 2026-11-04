<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Domain\Settings\ClinicTime;
use App\Domain\Settings\TimeZones;
use DateTimeImmutable;
use DateTimeZone;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * The server's time-zone helper: which names are accepted (and which an
 * automatic detection may write), the labels written into emails, notices,
 * SMS and PDFs — identical to the TypeScript helpers (the shared parity
 * fixture) — and the DST-safe wall-clock arithmetic the slot engine uses.
 */
final class TimeZonesTest extends TestCase
{
    private const FIXTURE = __DIR__ . '/../../../../libs/shared/data-access/src/lib/time-zone-parity.fixture.json';

    /** The same rows as the fixture (spec §1.2.1 / §1.3), for when the shared fixture isn't there. */
    private const FALLBACK = [
        'abbr' => [
            ['Africa/Lagos', 'WAT', 'WAT'], ['Africa/Accra', 'GMT', 'GMT'], ['Africa/Nairobi', 'EAT', 'EAT'],
            ['Africa/Asmera', 'EAT', 'EAT'], ['Africa/Johannesburg', 'SAST', 'SAST'], ['Africa/Cairo', 'EET', 'EEST'],
            ['Europe/London', 'GMT', 'BST'], ['Europe/Dublin', 'GMT', 'IST'], ['Europe/Berlin', 'CET', 'CEST'],
            ['America/New_York', 'EST', 'EDT'], ['America/Indianapolis', 'EST', 'EDT'], ['America/Chicago', 'CST', 'CDT'],
            ['America/Denver', 'MST', 'MDT'], ['America/Phoenix', 'MST', 'MST'], ['America/Los_Angeles', 'PST', 'PDT'],
            ['America/Anchorage', 'AKST', 'AKDT'], ['Pacific/Honolulu', 'HST', 'HST'], ['Asia/Kolkata', 'IST', 'IST'],
            ['Asia/Calcutta', 'IST', 'IST'], ['Asia/Dubai', 'GMT+4', 'GMT+4'], ['Asia/Kathmandu', 'GMT+5:45', 'GMT+5:45'],
            ['Australia/Sydney', 'GMT+11', 'GMT+10'], ['America/Sao_Paulo', 'GMT-3', 'GMT-3'], ['UTC', 'UTC', 'UTC'],
        ],
        'labels' => [
            ['America/Chicago', '2026-09-08T14:05:00Z', 'when', 'Tue 8 Sep, 9:05 AM CDT'],
            ['Europe/London', '2027-09-30T08:30:00Z', 'when', 'Thu 30 Sep, 9:30 AM BST'],
            ['Africa/Lagos', '2026-11-04T15:00:00Z', 'when', 'Wed 4 Nov, 4:00 PM WAT'],
            ['America/Chicago', '2026-11-04T18:00:00Z', 'time', '12:00 PM CST'],
            ['Africa/Lagos', '2026-11-04T23:00:00Z', 'time', '12:00 AM WAT'],
            ['America/Chicago', '2025-11-04T15:00:00Z', 'when', 'Tue 4 Nov, 9:00 AM CST'],
        ],
    ];

    private static function z(string $name): DateTimeZone
    {
        return new DateTimeZone($name);
    }

    private static function at(string $iso): DateTimeImmutable
    {
        return new DateTimeImmutable($iso);
    }

    // ----- Validation -----

    public function testValidAcceptsRealZonesAndTheAliasesBrowsersReport(): void
    {
        foreach (['Africa/Lagos', 'America/Chicago', 'Asia/Calcutta', 'America/Indianapolis', 'Africa/Asmera', 'Atlantic/Reykjavik', 'UTC', 'America/Argentina/Buenos_Aires', 'America/Port-au-Prince', 'Etc/GMT+1'] as $tz) {
            $this->assertTrue(TimeZones::isValid($tz), $tz);
        }
        $this->assertTrue(TimeZones::isValid(' Africa/Lagos '), 'trimmed');
        foreach (['+01:00', 'Mars/Base', '', ' ', 'africa/lagos', 'EST5EDT', 'Africa/Lagos/Extra/Deep', str_repeat('A', 65), null, 1, ['Africa/Lagos']] as $tz) {
            $this->assertFalse(TimeZones::isValid($tz), var_export($tz, true));
        }
    }

    public function testDetectionNeverWritesUtcLikeZones(): void
    {
        foreach (['UTC', 'Etc/UTC', 'GMT', 'Etc/GMT+1', 'Zulu', 'Universal', 'Atlantic/Reykjavik'] as $tz) {
            $this->assertTrue(TimeZones::isValid($tz), "{$tz} stays choosable by hand");
            $this->assertFalse(TimeZones::isDetectable($tz), $tz);
        }
        foreach (['Africa/Lagos', 'America/Chicago', 'Europe/London', 'Asia/Calcutta'] as $tz) {
            $this->assertTrue(TimeZones::isDetectable($tz), $tz);
        }
        $this->assertFalse(TimeZones::isDetectable('+01:00'));
    }

    public function testZoneOrFallsBackToTheClinicZone(): void
    {
        ClinicTime::configure('Africa/Lagos');
        $this->assertSame('America/Chicago', TimeZones::zoneOr('America/Chicago')->getName());
        $this->assertSame('Africa/Lagos', TimeZones::zoneOr(null)->getName());
        $this->assertSame('Africa/Lagos', TimeZones::zoneOr('+01:00')->getName(), 'a raw offset is never a zone');
        $this->assertSame('Europe/London', TimeZones::zoneOr('nope', self::z('Europe/London'))->getName());
    }

    // ----- Parity with the TypeScript helpers -----

    /** @return iterable<string, array{string, string, string}> */
    public static function abbrRows(): iterable
    {
        foreach (self::fixture()['abbr'] as $row) {
            yield $row['tz'] . ' ' . $row['at'] => [$row['tz'], $row['at'], $row['abbr']];
        }
    }

    /** @return iterable<string, array{string, string, string, string}> */
    public static function labelRows(): iterable
    {
        foreach (self::fixture()['labels'] as $row) {
            yield $row['fn'] . ' ' . $row['tz'] . ' ' . $row['at'] => [$row['tz'], $row['at'], $row['fn'], $row['text']];
        }
    }

    #[DataProvider('abbrRows')]
    public function testAbbreviationsMatchTheSharedFixture(string $tz, string $at, string $abbr): void
    {
        $this->assertSame($abbr, TimeZones::abbr(self::at($at), self::z($tz)));
    }

    #[DataProvider('labelRows')]
    public function testLabelsMatchTheSharedFixture(string $tz, string $at, string $fn, string $text): void
    {
        $label = $fn === 'when' ? TimeZones::when(self::at($at), self::z($tz)) : TimeZones::time(self::at($at), self::z($tz));
        $this->assertSame($text, $label);
        $this->assertMatchesRegularExpression('/^[\x20-\x7E]+$/', $label, 'pure ASCII: no U+202F or U+00A0');
    }

    public function testTheFallbackTableIsTheFixture(): void
    {
        if (!is_file(self::FIXTURE)) {
            $this->markTestSkipped('The shared fixture is not in this checkout (the tables above stand in for it).');
        }
        $this->assertSame(self::FALLBACK, self::fromFile(), 'the PHP copy of the rows equals the shared fixture');
    }

    public function testAbbreviationsBuiltFromOffsetsOutsideTheMap(): void
    {
        $this->assertSame('NST', TimeZones::abbr(self::at('2027-01-15T12:00:00Z'), self::z('America/St_Johns')), 'mapped');
        $this->assertSame('GMT-3:30', TimeZones::abbr(self::at('2027-01-15T12:00:00Z'), new DateTimeZone('-03:30')), 'negative with minutes');
        $this->assertSame('GMT', TimeZones::abbr(self::at('2027-01-15T12:00:00Z'), self::z('Etc/GMT')), 'zero offset, unmapped');
        $this->assertSame('GMT+1', TimeZones::abbr(self::at('2027-01-15T12:00:00Z'), new DateTimeZone('+01:00')), 'a raw offset zone');
        $this->assertSame('GMT+14', TimeZones::abbr(self::at('2027-01-15T12:00:00Z'), self::z('Pacific/Kiritimati')));
        $this->assertSame('GMT-11', TimeZones::abbr(self::at('2027-01-15T12:00:00Z'), self::z('Pacific/Pago_Pago')));
    }

    // ----- Labels -----

    public function testLabelFormats(): void
    {
        $chicago = self::z('America/Chicago');
        $this->assertSame('Tue 4 Nov, 9:00 AM CST', TimeZones::when(self::at('2025-11-04T15:00:00Z'), $chicago), '4 Nov 2026 is a Wednesday, hence 2025');
        $this->assertSame('Wed, 4 Nov 2026', TimeZones::date(self::at('2026-11-04T15:00:00Z'), $chicago));
        $this->assertSame('Wed, 4 Nov 2026 at 9:00 AM CST', TimeZones::dateTime(self::at('2026-11-04T15:00:00Z'), $chicago));
        $this->assertSame('4 Nov 2026, 09:12 CST', TimeZones::stamp(self::at('2026-11-04T15:12:00Z'), $chicago));
        $this->assertSame('Sep', TimeZones::MONTHS[8], 'never "Sept"');
        $this->assertSame('12:30 AM WAT', TimeZones::time(self::at('2026-11-04T23:30:00Z'), self::z('Africa/Lagos')));
    }

    public function testDualAddsTheOtherPartysTimeOnlyWhenOffsetsDiffer(): void
    {
        $chicago = self::z('America/Chicago');
        $lagos   = self::z('Africa/Lagos');
        $this->assertSame(
            "Mon 2 Nov, 11:00 PM CST (Tue 6:00 AM WAT, your patient's time)",
            TimeZones::dual(self::at('2026-11-03T05:00:00Z'), $chicago, $lagos, "your patient's time"),
            'the other weekday when the date differs',
        );
        $this->assertSame(
            "9:00 AM CST (4:00 PM WAT, your patient's time)",
            TimeZones::dual(self::at('2026-11-04T15:00:00Z'), $chicago, $lagos, "your patient's time", 'time'),
        );
        $this->assertSame(
            'Wed, 4 Nov 2026 at 9:00 AM CST (4:00 PM WAT, VideoMed time)',
            TimeZones::dual(self::at('2026-11-04T15:00:00Z'), $chicago, $lagos, 'VideoMed time', 'dateTime'),
        );
        $this->assertSame('Wed 4 Nov, 4:00 PM WAT', TimeZones::dual(self::at('2026-11-04T15:00:00Z'), $lagos, self::z('Africa/Kinshasa'), 'x'), 'same offset: no bracket');
        $this->assertSame('Wed 4 Nov, 4:00 PM WAT', TimeZones::dual(self::at('2026-11-04T15:00:00Z'), $lagos, null, 'x'), 'no other zone');
        // Offsets compared per instant: London and Lagos agree in winter, not in summer.
        $this->assertFalse(TimeZones::offsetsDiffer(self::at('2027-01-15T12:00:00Z'), self::z('Europe/London'), self::z('UTC')));
        $this->assertTrue(TimeZones::offsetsDiffer(self::at('2027-07-15T12:00:00Z'), self::z('Europe/London'), self::z('UTC')));
    }

    // ----- Wall clock -----

    public function testLocalDaysAre23Or25HoursAcrossDst(): void
    {
        $chicago = self::z('America/Chicago');
        [$a, $b] = TimeZones::localDayBounds('2027-11-07', $chicago);
        $this->assertSame(25 * 3600, $b - $a, 'fall back');
        [$a, $b] = TimeZones::localDayBounds('2027-03-14', $chicago);
        $this->assertSame(23 * 3600, $b - $a, 'spring forward');
        $this->assertSame(self::at('2027-03-14T06:00:00Z')->getTimestamp(), $a);
        $this->assertSame('2027-03-14', TimeZones::localDate($a, $chicago));
        $this->assertSame('2027-03-13', TimeZones::localDate($a - 1, $chicago));
    }

    public function testWallToInstantRollsGapsForwardAndTakesTheFirstOccurrence(): void
    {
        $chicago = self::z('America/Chicago');
        // 02:30 doesn't exist on 2027-03-14: it rolls forward to 03:30 CDT.
        $this->assertSame(self::at('2027-03-14T03:30:00-05:00')->getTimestamp(), TimeZones::wallToInstant('2027-03-14', 150, $chicago));
        // 01:30 happens twice on 2027-11-07: the first (CDT).
        $this->assertSame(self::at('2027-11-07T01:30:00-05:00')->getTimestamp(), TimeZones::wallToInstant('2027-11-07', 90, $chicago));
        // 1440 is the next local midnight.
        $this->assertSame(TimeZones::localDayBounds('2027-11-07', $chicago)[1], TimeZones::wallToInstant('2027-11-07', 1440, $chicago));
        $this->assertSame(self::at('2026-11-04T08:00:00Z')->getTimestamp(), TimeZones::wallToInstant('2026-11-04', 540, self::z('Africa/Lagos')));
        $this->assertSame(540, TimeZones::minutesOfDay(self::at('2026-11-04T08:00:00Z')->getTimestamp(), self::z('Africa/Lagos')));
    }

    /**
     * PHP's own parser takes the SECOND occurrence of a repeated wall time in
     * European and Australian zones (the first in American ones); wallToInstant
     * takes the first everywhere, like the TS zonedLocalToIso.
     *
     * @return iterable<string, array{string, string, int, string}>
     */
    public static function europeanAndAustralianWallTimes(): iterable
    {
        yield 'London fall back 01:30 (BST)'   => ['Europe/London', '2026-10-25', 90, '2026-10-25T00:30:00Z'];
        yield 'Berlin fall back 02:30 (CEST)'  => ['Europe/Berlin', '2026-10-25', 150, '2026-10-25T00:30:00Z'];
        yield 'Sydney fall back 02:30 (AEDT)'  => ['Australia/Sydney', '2027-04-04', 150, '2027-04-03T15:30:00Z'];
        yield 'London gap 01:30 rolls forward' => ['Europe/London', '2027-03-28', 90, '2027-03-28T01:30:00Z'];
        yield 'Berlin gap 02:30 rolls forward' => ['Europe/Berlin', '2027-03-28', 150, '2027-03-28T01:30:00Z'];
        yield 'London an ordinary 09:00 (BST)' => ['Europe/London', '2026-10-24', 540, '2026-10-24T08:00:00Z'];
        yield 'London an ordinary 09:00 (GMT)' => ['Europe/London', '2026-10-26', 540, '2026-10-26T09:00:00Z'];
    }

    #[DataProvider('europeanAndAustralianWallTimes')]
    public function testARepeatedWallTimeIsTheFirstOccurrenceInEveryZone(string $tz, string $ymd, int $minutes, string $expected): void
    {
        $this->assertSame(self::at($expected)->getTimestamp(), TimeZones::wallToInstant($ymd, $minutes, self::z($tz)));
    }

    public function testEuropeanDayBoundsAcrossDst(): void
    {
        $london = self::z('Europe/London');
        $this->assertSame([self::at('2026-10-24T23:00:00Z')->getTimestamp(), self::at('2026-10-26T00:00:00Z')->getTimestamp()], TimeZones::localDayBounds('2026-10-25', $london), '25 hours');
        $this->assertSame([self::at('2027-03-28T00:00:00Z')->getTimestamp(), self::at('2027-03-28T23:00:00Z')->getTimestamp()], TimeZones::localDayBounds('2027-03-28', $london), '23 hours');
        // Wall clock 01:00 is read as 01:00 BST, so 01:00–02:00 spans both runs of the repeated hour.
        $this->assertSame(2 * 3600, TimeZones::wallToInstant('2026-10-25', 120, $london) - TimeZones::wallToInstant('2026-10-25', 60, $london));
    }

    /** @return array{abbr: list<array{string,string,string}>, labels: list<array{string,string,string,string}>} */
    private static function fromFile(): array
    {
        $raw  = json_decode((string) file_get_contents(self::FIXTURE), true, flags: JSON_THROW_ON_ERROR);
        $abbr = [];
        foreach ($raw['abbr'] as $row) {
            $abbr[$row['tz']][$row['at'] === '2027-01-15T12:00:00Z' ? 1 : 2] = $row['abbr'];
        }
        $outAbbr = [];
        foreach ($abbr as $tz => $pair) {
            $outAbbr[] = [$tz, $pair[1], $pair[2]];
        }

        return [
            'abbr'   => $outAbbr,
            'labels' => array_map(static fn (array $r): array => [$r['tz'], $r['at'], $r['fn'], $r['text']], $raw['labels']),
        ];
    }

    /** The shared fixture (read by the TS suite too), else the same rows from the spec tables. */
    private static function fixture(): array
    {
        if (is_file(self::FIXTURE)) {
            return json_decode((string) file_get_contents(self::FIXTURE), true, flags: JSON_THROW_ON_ERROR);
        }
        $abbr = [];
        foreach (self::FALLBACK['abbr'] as [$tz, $jan, $jul]) {
            $abbr[] = ['tz' => $tz, 'at' => '2027-01-15T12:00:00Z', 'abbr' => $jan];
            $abbr[] = ['tz' => $tz, 'at' => '2027-07-15T12:00:00Z', 'abbr' => $jul];
        }

        return [
            'abbr'   => $abbr,
            'labels' => array_map(static fn (array $r): array => ['tz' => $r[0], 'at' => $r[1], 'fn' => $r[2], 'text' => $r[3]], self::FALLBACK['labels']),
        ];
    }
}
