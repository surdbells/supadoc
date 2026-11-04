<?php

declare(strict_types=1);

namespace App\Tests\Integration\Doctor;

use App\Action\Doctor\UpdateDoctorProfileAction;
use App\Tests\Integration\DocumentSharing\DocShareTestCase;

/**
 * PATCH /api/doctor/profile `weekly_hours` (spec §1.6): weekday "0"–"6" → up to
 * six [start, end] "HH:MM" windows on the doctor's own clock, earliest first,
 * not overlapping, "24:00" allowed as an end — anything else is a 422 and
 * nothing is stored.
 */
final class WeeklyHoursValidationTest extends DocShareTestCase
{
    /** @return array{status:int, body:array<string,mixed>} */
    private function patch(mixed $hours): array
    {
        $res = $this->doctorAction(UpdateDoctorProfileAction::class, $this->userA, [], ['weekly_hours' => $hours], [], 'PATCH');
        unset($res['response']);

        return $res;
    }

    private function stored(): mixed
    {
        $raw = $this->conn()->fetchOne('SELECT weekly_hours FROM specialists WHERE id = ?', [$this->A]);

        return $raw === null || $raw === false ? null : json_decode((string) $raw, true);
    }

    public function testValidHoursAreStored(): void
    {
        $res = $this->patch(['1' => [['09:00', '12:00'], ['13:00', '24:00']]]);
        $this->assertSame(200, $res['status'], json_encode($res['body']));
        $this->assertSame(['1' => [['09:00', '12:00'], ['13:00', '24:00']]], $this->stored());

        $this->assertSame(200, $this->patch([])['status']);
        $this->assertNull($this->stored(), 'an empty map clears them');
    }

    public function testMalformedHoursAreRefusedAndNothingIsStored(): void
    {
        $this->patch(['2' => [['10:00', '11:00']]]);
        $cases = [
            'a key "7"'           => ['7' => [['09:00', '10:00']]],
            'a "25:00"'           => ['1' => [['09:00', '25:00']]],
            'a start after its end' => ['1' => [['12:00', '09:00']]],
            'overlapping pairs'   => ['1' => [['09:00', '12:00'], ['11:00', '13:00']]],
            'seven pairs'         => ['1' => array_map(static fn (int $h): array => [sprintf('%02d:00', $h), sprintf('%02d:30', $h)], range(8, 14))],
            'not a map'           => 'weekdays',
        ];
        foreach ($cases as $why => $hours) {
            $res = $this->patch($hours);
            $this->assertSame(422, $res['status'], $why);
            $this->assertSame(['weekly_hours' => "Enter each day's hours as start and end times, earliest first, without overlaps"], $res['body']['errors'], $why);
        }
        $this->assertSame(['2' => [['10:00', '11:00']]], $this->stored(), 'the earlier hours stand');
    }
}
