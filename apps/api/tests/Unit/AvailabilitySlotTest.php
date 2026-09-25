<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Domain\Entity\AvailabilitySlot;
use App\Domain\Entity\Specialist;
use App\Domain\Enum\SlotKind;
use DateTimeImmutable;
use PHPUnit\Framework\TestCase;

/**
 * Guards the block-collision primitive behind the availability engine: a block
 * must reject any slot it overlaps, not only one whose start instant it covers.
 * A regression here silently lets patients book time a doctor blocked.
 */
final class AvailabilitySlotTest extends TestCase
{
    private function slot(string $start, string $end): AvailabilitySlot
    {
        return new AvailabilitySlot(
            $this->createStub(Specialist::class),
            new DateTimeImmutable($start),
            new DateTimeImmutable($end),
            SlotKind::BLOCK,
        );
    }

    public function testCoversIsStartInclusiveEndExclusive(): void
    {
        $block = $this->slot('2026-01-01 09:00', '2026-01-01 10:00');

        $this->assertTrue($block->covers(new DateTimeImmutable('2026-01-01 09:00')));
        $this->assertTrue($block->covers(new DateTimeImmutable('2026-01-01 09:30')));
        $this->assertFalse($block->covers(new DateTimeImmutable('2026-01-01 10:00')));
        $this->assertFalse($block->covers(new DateTimeImmutable('2026-01-01 08:59')));
    }

    public function testOverlapsCatchesABlockBeginningMidSlot(): void
    {
        // The bug: a block 09:15–09:45 begins after the 09:00 slot's start, so a
        // point test on the slot start (09:00) misses it. Span-overlap must not.
        $block = $this->slot('2026-01-01 09:15', '2026-01-01 09:45');

        $slotStart = new DateTimeImmutable('2026-01-01 09:00');
        $slotEnd   = new DateTimeImmutable('2026-01-01 09:30'); // 30-min slot

        $this->assertFalse($block->covers($slotStart), 'point test misses it (the old bug)');
        $this->assertTrue($block->overlaps($slotStart, $slotEnd), 'span test catches it');
    }

    public function testOverlapsHandlesABlockFullyInsideALongerSlot(): void
    {
        // A 09:15–09:45 block sitting entirely inside a 09:00–10:00 open slot.
        $block = $this->slot('2026-01-01 09:15', '2026-01-01 09:45');

        $this->assertTrue($block->overlaps(
            new DateTimeImmutable('2026-01-01 09:00'),
            new DateTimeImmutable('2026-01-01 10:00'),
        ));
    }

    public function testOverlapsIsHalfOpenAtTheBoundaries(): void
    {
        $block = $this->slot('2026-01-01 09:00', '2026-01-01 10:00');

        // Adjacent, non-overlapping neighbours must NOT collide.
        $this->assertFalse($block->overlaps(
            new DateTimeImmutable('2026-01-01 08:30'),
            new DateTimeImmutable('2026-01-01 09:00'),
        ), 'a slot ending exactly at the block start does not overlap');
        $this->assertFalse($block->overlaps(
            new DateTimeImmutable('2026-01-01 10:00'),
            new DateTimeImmutable('2026-01-01 10:30'),
        ), 'a slot starting exactly at the block end does not overlap');
    }
}
