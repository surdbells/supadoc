<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Domain\Document\ReschedulePolicy;
use App\Domain\Document\ShareDuration;
use DateTimeImmutable;
use PHPUnit\Framework\TestCase;

/** Where an `after_*` share ends once its consultation moves (spec §1.2). */
final class ReschedulePolicyTest extends TestCase
{
    public function testAPatientMoveRecomputesAndRebases(): void
    {
        $original = new DateTimeImmutable('2026-10-30 11:00:00');
        $newEnd   = new DateTimeImmutable('2026-11-05 10:30:00');
        $r        = ReschedulePolicy::newEnd(ShareDuration::AFTER_7D, $newEnd, $original, 'patient');

        $this->assertEquals($newEnd->modify('+7 days'), $r['expires_at']);
        $this->assertEquals($r['expires_at'], $r['original_expires_at']);
        $this->assertFalse($r['capped']);
    }

    public function testADoctorMoveIsCappedAtTheOriginalPlusThirtyDays(): void
    {
        $original = new DateTimeImmutable('2026-10-30 11:00:00');
        $r        = ReschedulePolicy::newEnd(ShareDuration::AFTER_7D, $original->modify('-7 days')->modify('+40 days'), $original, 'doctor');

        $this->assertEquals($original->modify('+30 days'), $r['expires_at']);
        $this->assertTrue($r['capped']);
        $this->assertEquals($original, $r['original_expires_at'], 'the base is kept');
    }

    public function testADoctorMovingItEarlierShortensIt(): void
    {
        $original = new DateTimeImmutable('2026-10-30 11:00:00');
        $r        = ReschedulePolicy::newEnd(ShareDuration::AFTER_24H, new DateTimeImmutable('2026-10-25 10:00:00'), $original, 'staff');

        $this->assertEquals(new DateTimeImmutable('2026-10-26 10:00:00'), $r['expires_at']);
        $this->assertFalse($r['capped']);
    }

    public function testRepeatedDoctorMovesNeverExceedTheCap(): void
    {
        $original = new DateTimeImmutable('2026-10-30 11:00:00');
        $base     = $original;
        foreach (['+20 days', '+40 days', '+90 days'] as $move) {
            $r    = ReschedulePolicy::newEnd(ShareDuration::AFTER_30D, $original->modify($move), $base, 'doctor');
            $base = $r['original_expires_at'];
            $this->assertLessThanOrEqual($original->modify('+30 days'), $r['expires_at']);
        }
    }

    public function testOnlyAnchoredSharesFollowAConsultation(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        ReschedulePolicy::newEnd(ShareDuration::D7, new DateTimeImmutable(), null, 'patient');
    }
}
