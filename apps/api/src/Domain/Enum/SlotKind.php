<?php

declare(strict_types=1);

namespace App\Domain\Enum;

/**
 * What an {@see \App\Domain\Entity\AvailabilitySlot} row represents:
 *   - OPEN  — a bookable window the doctor published.
 *   - BLOCK — time the doctor marked unavailable (leave, a break, a full day).
 *
 * "Booked" is NOT a kind: it is derived at read time by matching a live
 * appointment to an open slot, so the two never fall out of sync.
 */
enum SlotKind: string
{
    case OPEN  = 'open';
    case BLOCK = 'block';

    public function label(): string
    {
        return match ($this) {
            self::OPEN  => 'Open',
            self::BLOCK => 'Blocked',
        };
    }
}
