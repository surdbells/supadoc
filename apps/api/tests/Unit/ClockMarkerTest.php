<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Domain\Entity\Appointment;
use App\Domain\Entity\AvailabilitySlot;
use App\Domain\Entity\Patient;
use App\Domain\Entity\Specialist;
use App\Domain\Enum\SlotKind;
use App\Infrastructure\Persistence\ClockRepair;
use DateTimeImmutable;
use PHPUnit\Framework\TestCase;

/**
 * Every write of a start puts it on the process clock (what a read returns)
 * and marks it with its unix time — the clock-repair marker (prod-migrate step
 * 13). Run on Asia/Shanghai, like production's PRC.
 */
final class ClockMarkerTest extends TestCase
{
    private string $zone = 'UTC';

    protected function setUp(): void
    {
        $this->zone = date_default_timezone_get();
        date_default_timezone_set('Asia/Shanghai');
    }

    protected function tearDown(): void
    {
        date_default_timezone_set($this->zone);
        ClockRepair::resetCache();
    }

    private function appointment(string $at): Appointment
    {
        $patient = new Patient('marker@example.test', 'Test', 'Patient');
        $patient->initTimestamps();
        $doctor = new Specialist('Dr. Marker', 'General Practice');
        $doctor->setConsultationFee('10000.00');
        $appointment = new Appointment($patient, $doctor, new DateTimeImmutable($at));
        $appointment->initTimestamps();

        return $appointment;
    }

    public function testAnAppointmentIsPlacedOnTheProcessClockAndMarked(): void
    {
        $a = $this->appointment('2026-10-21T09:00:00Z');

        $this->assertSame('Asia/Shanghai', $a->getScheduledAt()->getTimezone()->getName());
        $this->assertSame('17:00', $a->getScheduledAt()->format('H:i'));
        $this->assertSame((new DateTimeImmutable('2026-10-21T09:00:00Z'))->getTimestamp(), $a->getScheduledEpoch());
        $this->assertSame('2026-10-21T17:00:00+08:00', $a->toArray()['scheduled_at']);
    }

    public function testEveryMoveUpdatesTheValueAndTheMarker(): void
    {
        $a     = $this->appointment('2026-10-21T09:00:00Z');
        $later = new DateTimeImmutable('2026-10-22T10:30:00+00:00');
        $a->setScheduledAt($later);
        $this->assertSame('2026-10-22 18:30', $a->getScheduledAt()->format('Y-m-d H:i'));
        $this->assertSame($later->getTimestamp(), $a->getScheduledEpoch());

        $moved = new DateTimeImmutable('2026-10-23T08:00:00Z');
        $a->moveProposal($moved, ['amount' => '5000.00']);
        $this->assertSame('Asia/Shanghai', $a->getScheduledAt()->getTimezone()->getName());
        $this->assertSame('2026-10-23 16:00', $a->getScheduledAt()->format('Y-m-d H:i'));
        $this->assertSame($moved->getTimestamp(), $a->getScheduledEpoch());
    }

    public function testTheSameInstantInAnotherZoneKeepsThePresenceStamps(): void
    {
        $a = $this->appointment('2026-10-21T09:00:00Z');
        $a->markFirstJoined('doctor', new DateTimeImmutable('2026-10-21T08:58:00Z'));

        $a->setScheduledAt(new DateTimeImmutable('2026-10-21T10:00:00+01:00')); // the same instant
        $this->assertNotNull($a->getDoctorFirstJoinedAt(), 'not a move: instants are compared');

        $a->setScheduledAt(new DateTimeImmutable('2026-10-21T11:00:00Z'));
        $this->assertNull($a->getDoctorFirstJoinedAt(), 'a real move clears the stamps');
    }

    public function testASlotIsStoredOnTheProcessClockAndListedInUtc(): void
    {
        $slot = new AvailabilitySlot(
            $this->createStub(Specialist::class),
            new DateTimeImmutable('2026-10-21T22:00:00Z'),
            new DateTimeImmutable('2026-10-21T22:30:00Z'),
            SlotKind::OPEN,
        );

        $this->assertSame('Asia/Shanghai', $slot->getStartsAt()->getTimezone()->getName());
        $this->assertSame('2026-10-22 06:00', $slot->getStartsAt()->format('Y-m-d H:i'));
        $this->assertSame((new DateTimeImmutable('2026-10-21T22:00:00Z'))->getTimestamp(), $slot->getStartsEpoch());
        $row = $slot->toArray();
        $this->assertSame('2026-10-21T22:00:00+00:00', $row['starts_at']);
        $this->assertSame('2026-10-21T22:30:00+00:00', $row['ends_at']);
    }
}
