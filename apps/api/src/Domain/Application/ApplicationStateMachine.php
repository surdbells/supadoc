<?php

declare(strict_types=1);

namespace App\Domain\Application;

use App\Domain\Enum\DoctorApplicationStatus as S;
use App\Domain\Exception\ApplicationProblem;

/**
 * Which action may move an application from which status, and where to
 * (spec §2.1). Pure. Every transition runs under the application lock with a
 * re-read row (see the services); {@see assertCan()} is the last word.
 */
final class ApplicationStateMachine
{
    public const SUBMIT             = 'submit';
    public const DISCARD            = 'discard';
    public const START_REVIEW       = 'start_review';
    public const REQUEST_INFO       = 'request_info';
    public const APPLICANT_REPLY    = 'applicant_reply';
    public const SCHEDULE_INTERVIEW = 'schedule_interview';
    public const RESEND_INTERVIEW   = 'resend_interview';
    public const APPROVE            = 'approve';
    public const REJECT             = 'reject';
    public const WITHDRAW           = 'withdraw';

    /** action => [from statuses, to status (null: unchanged / row deleted)] */
    private const TABLE = [
        self::SUBMIT             => [['draft'], 'submitted'],
        self::DISCARD            => [['draft'], null],
        self::START_REVIEW       => [['submitted', 'more_info_needed', 'interview_scheduled'], 'under_review'],
        self::REQUEST_INFO       => [['under_review', 'interview_scheduled'], 'more_info_needed'],
        self::APPLICANT_REPLY    => [['more_info_needed'], 'under_review'],
        self::SCHEDULE_INTERVIEW => [['under_review', 'interview_scheduled'], 'interview_scheduled'],
        self::RESEND_INTERVIEW   => [['interview_scheduled'], 'interview_scheduled'],
        self::APPROVE            => [['under_review', 'interview_scheduled'], 'approved'],
        self::REJECT             => [['submitted', 'under_review', 'more_info_needed', 'interview_scheduled'], 'rejected'],
        self::WITHDRAW           => [['submitted', 'under_review', 'more_info_needed', 'interview_scheduled'], 'withdrawn'],
    ];

    /** The refusal wording, per action. */
    private const REFUSALS = [
        self::SUBMIT             => 'This application has already been submitted.',
        self::DISCARD            => 'A submitted application cannot be cancelled. Withdraw it from your status page instead.',
        self::START_REVIEW       => "This application can't be moved to review now.",
        self::REQUEST_INFO       => "More information can't be requested at this stage.",
        self::APPLICANT_REPLY    => "This application isn't waiting for more information.",
        self::SCHEDULE_INTERVIEW => "An interview can't be scheduled at this stage.",
        self::RESEND_INTERVIEW   => 'There is no scheduled interview to resend.',
        self::APPROVE            => "This application can't be approved at this stage.",
        self::REJECT             => 'This application has already been decided.',
        self::WITHDRAW           => 'This application can no longer be withdrawn.',
    ];

    /** The staff actions in the order the back office lists them (DoctorApplicationAction). */
    public const STAFF_ACTIONS = [
        self::START_REVIEW, self::REQUEST_INFO, self::SCHEDULE_INTERVIEW, self::RESEND_INTERVIEW, self::APPROVE, self::REJECT,
    ];

    public static function can(S $from, string $action): bool
    {
        return isset(self::TABLE[$action]) && in_array($from->value, self::TABLE[$action][0], true);
    }

    /**
     * The status `$action` moves `$from` to (the same one for a resend; null
     * when the row goes away). 409 `not_allowed` otherwise.
     *
     * @throws ApplicationProblem
     */
    public static function assertCan(S $from, string $action): ?S
    {
        if (!isset(self::TABLE[$action])) {
            throw new \InvalidArgumentException('Unknown application action: ' . $action);
        }
        if (!self::can($from, $action)) {
            throw new ApplicationProblem(409, 'not_allowed', self::REFUSALS[$action]);
        }
        $to = self::TABLE[$action][1];

        return $to !== null ? S::from($to) : null;
    }

    /** Whether this move cancels a scheduled interview (more info requested at the interview stage). */
    public static function cancelsInterview(S $from, string $action): bool
    {
        return $action === self::REQUEST_INFO && $from === S::INTERVIEW_SCHEDULED;
    }

    /**
     * The staff actions open from `$status` (the detail page's buttons).
     *
     * @return list<string>
     */
    public static function staffActions(S $status): array
    {
        return array_values(array_filter(self::STAFF_ACTIONS, static fn (string $a): bool => self::can($status, $a)));
    }
}
