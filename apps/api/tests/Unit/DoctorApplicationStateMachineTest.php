<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Domain\Application\ApplicationStateMachine as SM;
use App\Domain\Enum\DoctorApplicationStatus as S;
use App\Domain\Exception\ApplicationProblem;
use PHPUnit\Framework\TestCase;

/** Spec §2.1: every allowed and refused transition; a refusal is 409 not_allowed. */
final class DoctorApplicationStateMachineTest extends TestCase
{
    /** action => [from => to] (to null: the row goes away) */
    private const ALLOWED = [
        SM::SUBMIT             => ['draft' => 'submitted'],
        SM::DISCARD            => ['draft' => null],
        SM::START_REVIEW       => ['submitted' => 'under_review', 'more_info_needed' => 'under_review', 'interview_scheduled' => 'under_review'],
        SM::REQUEST_INFO       => ['under_review' => 'more_info_needed', 'interview_scheduled' => 'more_info_needed'],
        SM::APPLICANT_REPLY    => ['more_info_needed' => 'under_review'],
        SM::SCHEDULE_INTERVIEW => ['under_review' => 'interview_scheduled', 'interview_scheduled' => 'interview_scheduled'],
        SM::RESEND_INTERVIEW   => ['interview_scheduled' => 'interview_scheduled'],
        SM::APPROVE            => ['under_review' => 'approved', 'interview_scheduled' => 'approved'],
        SM::REJECT             => ['submitted' => 'rejected', 'under_review' => 'rejected', 'more_info_needed' => 'rejected', 'interview_scheduled' => 'rejected'],
        SM::WITHDRAW           => ['submitted' => 'withdrawn', 'under_review' => 'withdrawn', 'more_info_needed' => 'withdrawn', 'interview_scheduled' => 'withdrawn'],
    ];

    public function testEveryAllowedAndRefusedTransition(): void
    {
        foreach (self::ALLOWED as $action => $moves) {
            foreach (S::cases() as $from) {
                if (array_key_exists($from->value, $moves)) {
                    $to = SM::assertCan($from, $action);
                    $this->assertSame($moves[$from->value], $to?->value, "{$action} from {$from->value}");
                    $this->assertTrue(SM::can($from, $action));
                    continue;
                }
                $this->assertFalse(SM::can($from, $action), "{$action} from {$from->value}");
                try {
                    SM::assertCan($from, $action);
                    $this->fail("{$action} from {$from->value} must be refused");
                } catch (ApplicationProblem $p) {
                    $this->assertSame(409, $p->status);
                    $this->assertSame('not_allowed', $p->errorCode);
                    $this->assertNotSame('', $p->getMessage());
                }
            }
        }
    }

    public function testWithdrawRefusalWording(): void
    {
        try {
            SM::assertCan(S::APPROVED, SM::WITHDRAW);
            $this->fail('refused');
        } catch (ApplicationProblem $p) {
            $this->assertSame('This application can no longer be withdrawn.', $p->getMessage());
        }
    }

    public function testRequestingInfoFromTheInterviewStageCancelsTheInterview(): void
    {
        $this->assertTrue(SM::cancelsInterview(S::INTERVIEW_SCHEDULED, SM::REQUEST_INFO));
        $this->assertFalse(SM::cancelsInterview(S::UNDER_REVIEW, SM::REQUEST_INFO));
        $this->assertFalse(SM::cancelsInterview(S::INTERVIEW_SCHEDULED, SM::REJECT));
    }

    public function testStaffActionsPerStatus(): void
    {
        $this->assertSame(['start_review', 'reject'], SM::staffActions(S::SUBMITTED));
        $this->assertSame(['request_info', 'schedule_interview', 'approve', 'reject'], SM::staffActions(S::UNDER_REVIEW));
        $this->assertSame(['start_review', 'reject'], SM::staffActions(S::MORE_INFO_NEEDED));
        $this->assertSame(['start_review', 'request_info', 'schedule_interview', 'resend_interview', 'approve', 'reject'], SM::staffActions(S::INTERVIEW_SCHEDULED));
        foreach ([S::APPROVED, S::REJECTED, S::WITHDRAWN, S::DRAFT] as $s) {
            $this->assertSame([], SM::staffActions($s));
        }
    }

    public function testOpenAndTerminal(): void
    {
        $this->assertSame(['submitted', 'under_review', 'more_info_needed', 'interview_scheduled'], array_values(array_map(
            static fn (S $s): string => $s->value,
            array_filter(S::cases(), static fn (S $s): bool => $s->isOpen()),
        )));
        $this->assertTrue(S::WITHDRAWN->isTerminal());
        $this->assertFalse(S::DRAFT->isTerminal());
        $this->assertSame('New', S::SUBMITTED->label());
        $this->assertSame('Under Review', S::UNDER_REVIEW->applicantLabel());
    }
}
