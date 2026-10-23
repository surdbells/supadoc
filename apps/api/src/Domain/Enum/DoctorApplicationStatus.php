<?php

declare(strict_types=1);

namespace App\Domain\Enum;

/**
 * Where a doctor's application stands (spec §2.1). A draft is the applicant's
 * own work in progress (never shown to staff); submitted … interview_scheduled
 * are "open" (one per email at a time); approved, rejected and withdrawn are
 * final. The transitions live in {@see \App\Domain\Application\ApplicationStateMachine}.
 */
enum DoctorApplicationStatus: string
{
    case DRAFT               = 'draft';
    case SUBMITTED           = 'submitted';
    case UNDER_REVIEW        = 'under_review';
    case MORE_INFO_NEEDED    = 'more_info_needed';
    case INTERVIEW_SCHEDULED = 'interview_scheduled';
    case APPROVED            = 'approved';
    case REJECTED            = 'rejected';
    case WITHDRAWN           = 'withdrawn';

    /** The statuses of an open application (one per email — the partial unique index). */
    public const OPEN = ['submitted', 'under_review', 'more_info_needed', 'interview_scheduled'];

    /** The back office's wording. */
    public function label(): string
    {
        return match ($this) {
            self::DRAFT               => 'Draft',
            self::SUBMITTED           => 'New',
            self::UNDER_REVIEW        => 'Under review',
            self::MORE_INFO_NEEDED    => 'More info needed',
            self::INTERVIEW_SCHEDULED => 'Interview scheduled',
            self::APPROVED            => 'Approved',
            self::REJECTED            => 'Rejected',
            self::WITHDRAWN           => 'Withdrawn',
        };
    }

    /** The applicant's wording (status page, timeline). */
    public function applicantLabel(): string
    {
        return match ($this) {
            self::DRAFT               => 'Draft',
            self::SUBMITTED           => 'Submitted',
            self::UNDER_REVIEW        => 'Under Review',
            self::MORE_INFO_NEEDED    => 'More Info Needed',
            self::INTERVIEW_SCHEDULED => 'Interview Scheduled',
            self::APPROVED            => 'Approved',
            self::REJECTED            => 'Rejected',
            self::WITHDRAWN           => 'Withdrawn',
        };
    }

    /** What the status means for the applicant (spec §6.10). */
    public function applicantDescription(): string
    {
        return match ($this) {
            self::DRAFT               => 'Your application is saved but not submitted yet.',
            self::SUBMITTED           => "We've received your application. A credentialing officer will pick it up for review shortly.",
            self::UNDER_REVIEW        => "We're verifying your licence, qualifications and documents. You don't need to do anything right now.",
            self::MORE_INFO_NEEDED    => "Please send the items we've requested. Your review resumes as soon as we receive them.",
            self::INTERVIEW_SCHEDULED => 'Join your interview at the scheduled time and have your ID and licence to hand.',
            self::APPROVED            => 'Welcome aboard. Set up your profile and availability so patients can start booking you.',
            self::REJECTED            => "The outcome is shown on this page. Contact support if you'd like to talk it through.",
            self::WITHDRAWN           => 'You withdrew this application. You can apply again at any time.',
        };
    }

    public function isOpen(): bool
    {
        return in_array($this->value, self::OPEN, true);
    }

    public function isTerminal(): bool
    {
        return $this === self::APPROVED || $this === self::REJECTED || $this === self::WITHDRAWN;
    }
}
