<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Domain\Doctor\WeeklyHours;
use App\Infrastructure\Service\DoctorTimeZoneService;
use App\Domain\Entity\AvailabilitySlot;
use App\Domain\Entity\Specialist;
use App\Domain\Enum\SlotKind;
use DateTimeImmutable;
use DateTimeZone;
use PHPUnit\Framework\TestCase;

/**
 * The doctor's weekly hours as PATCH /doctor/profile accepts them (wall clock
 * on their own clock), and where a zone change moves a published time.
 */
final class WeeklyHoursTest extends TestCase
{
    public function testWellFormedHoursAreKept(): void
    {
        $this->assertSame(
            ['1' => [['09:00', '12:00'], ['13:00', '24:00']]],
            WeeklyHours::normalize(['1' => [['09:00', '12:00'], ['13:00', '24:00']]]),
        );
        $this->assertSame(['0' => [['00:00', '01:00']], '6' => [['10:00', '11:00']]], WeeklyHours::normalize(['6' => [['10:00', '11:00']], '0' => [['00:00', '01:00']]]));
        $this->assertSame(['2' => [['09:00', '10:00']]], WeeklyHours::normalize(['1' => [], '2' => [['09:00', '10:00']]]), 'an empty day is dropped');
        $this->assertNull(WeeklyHours::normalize(null), 'cleared');
        $this->assertNull(WeeklyHours::normalize([]), 'cleared');
        $this->assertSame(['1' => [['09:00', '10:00'], ['10:00', '11:00']]], WeeklyHours::normalize(['1' => [['09:00', '10:00'], ['10:00', '11:00']]]), 'touching windows are fine');
    }

    public function testMalformedHoursAreRefused(): void
    {
        $bad = [
            'not an object'   => 'Mon 9-5',
            'weekday 7'       => ['7' => [['09:00', '10:00']]],
            'named weekday'   => ['mon' => [['09:00', '10:00']]],
            '25:00'           => ['1' => [['09:00', '25:00']]],
            '24:00 start'     => ['1' => [['24:00', '24:00']]],
            '24:30 end'       => ['1' => [['23:00', '24:30']]],
            'start after end' => ['1' => [['12:00', '09:00']]],
            'empty window'    => ['1' => [['09:00', '09:00']]],
            'overlapping'     => ['1' => [['09:00', '12:00'], ['11:00', '13:00']]],
            'not earliest first' => ['1' => [['13:00', '14:00'], ['09:00', '10:00']]],
            'seven windows'   => ['1' => array_map(static fn (int $h): array => [sprintf('%02d:00', $h), sprintf('%02d:30', $h)], range(8, 14))],
            'three values'    => ['1' => [['09:00', '10:00', '11:00']]],
            'not a list'      => ['1' => ['start' => '09:00', 'end' => '10:00']],
            'H:MM'            => ['1' => [['9:00', '10:00']]],
        ];
        foreach ($bad as $why => $hours) {
            $this->assertFalse(WeeklyHours::normalize($hours), $why);
        }
        $this->assertSame("Enter each day's hours as start and end times, earliest first, without overlaps", WeeklyHours::MESSAGE);
    }

    public function testAZoneChangeKeepsEachRowsWallClock(): void
    {
        $doctor  = new Specialist('Dr. Ada', 'GP');
        $lagos   = new DateTimeZone('Africa/Lagos');
        $chicago = new DateTimeZone('America/Chicago');

        // 09:00 WAT (08:00Z) → 09:00 CST (15:00Z), same length.
        $open = new AvailabilitySlot($doctor, new DateTimeImmutable('2026-11-10T08:00:00Z'), new DateTimeImmutable('2026-11-10T08:30:00Z'));
        [$s, $e] = DoctorTimeZoneService::moved($open, $lagos, $chicago);
        $this->assertSame((new DateTimeImmutable('2026-11-10T15:00:00Z'))->getTimestamp(), $s);
        $this->assertSame(1800, $e - $s);

        // An entire-day block becomes the same local day in the new zone (Chicago's 2027-03-14 is 23 hours).
        $block = new AvailabilitySlot($doctor, new DateTimeImmutable('2027-03-13T23:00:00Z'), new DateTimeImmutable('2027-03-14T23:00:00Z'), SlotKind::BLOCK);
        [$s, $e] = DoctorTimeZoneService::moved($block, $lagos, $chicago);
        $this->assertSame((new DateTimeImmutable('2027-03-14T06:00:00Z'))->getTimestamp(), $s);
        $this->assertSame(23 * 3600, $e - $s);

        // A move re-sets the clock-repair marker from the instant.
        $open->reschedule(new DateTimeImmutable('@' . 1793000000), new DateTimeImmutable('@' . 1793001800));
        $this->assertSame(1793000000, $open->getStartsEpoch());
        $this->assertSame(1793000000, $open->getStartsAt()->getTimestamp());
        $this->assertSame(date_default_timezone_get(), $open->getStartsAt()->getTimezone()->getName(), 'on the process clock');
    }
}
