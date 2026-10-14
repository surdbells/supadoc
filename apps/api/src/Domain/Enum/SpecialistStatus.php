<?php

declare(strict_types=1);

namespace App\Domain\Enum;

/**
 * Where a doctor is in onboarding. A new specialist starts INVITED (setting up
 * their account and profile), submits for review (PENDING_REVIEW), and an admin
 * approves (APPROVED) or sends it back with a reason (REJECTED, then they fix and
 * resubmit). SUSPENDED takes an approved doctor out of the directory.
 *
 * A NULL status is a doctor from before onboarding existed and counts as
 * approved everywhere — see {@see isListable()}.
 */
enum SpecialistStatus: string
{
    case INVITED        = 'invited';
    case PENDING_REVIEW = 'pending_review';
    case APPROVED       = 'approved';
    case REJECTED       = 'rejected';
    case SUSPENDED      = 'suspended';

    public function label(): string
    {
        return match ($this) {
            self::INVITED        => 'Onboarding',
            self::PENDING_REVIEW => 'In review',
            self::APPROVED       => 'Approved',
            self::REJECTED       => 'Changes requested',
            self::SUSPENDED      => 'Suspended',
        };
    }

    /** May this doctor appear in the directory and take bookings? NULL = legacy = yes. */
    public static function isListable(?self $status): bool
    {
        return $status === null || $status === self::APPROVED;
    }
}
