<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Domain\Application\ApplicationTimeline;
use App\Domain\Enum\DoctorApplicationStatus as S;
use PHPUnit\Framework\TestCase;

/** Spec §3.2.20 / §6.5.12: the applicant's timeline rows. */
final class ApplicationTimelineTest extends TestCase
{
    /** @param list<string> $changes statuses in order, a minute apart @return list<array{to_status:string, at:string}> */
    private static function changes(string ...$changes): array
    {
        $out = [];
        foreach ($changes as $i => $to) {
            $out[] = ['to_status' => $to, 'at' => sprintf('2026-10-%02dT10:00:00+01:00', 10 + $i)];
        }

        return $out;
    }

    /** @return list<string> "key:state" */
    private static function shape(S $status, array $changes): array
    {
        return array_map(static fn (array $r): string => $r['key'] . ':' . $r['state'], ApplicationTimeline::rows($status, $changes));
    }

    public function testRowsForEveryStatus(): void
    {
        $this->assertSame(['submitted:current', 'under_review:pending', 'approved:pending'], self::shape(S::SUBMITTED, self::changes('submitted')));
        $this->assertSame(['submitted:done', 'under_review:current', 'approved:pending'], self::shape(S::UNDER_REVIEW, self::changes('submitted', 'under_review')));
        $this->assertSame(
            ['submitted:done', 'under_review:done', 'more_info_needed:current', 'approved:pending'],
            self::shape(S::MORE_INFO_NEEDED, self::changes('submitted', 'under_review', 'more_info_needed')),
        );
        $this->assertSame(
            ['submitted:done', 'under_review:done', 'interview_scheduled:current', 'approved:pending'],
            self::shape(S::INTERVIEW_SCHEDULED, self::changes('submitted', 'under_review', 'interview_scheduled')),
        );
        $this->assertSame(
            ['submitted:done', 'under_review:done', 'interview_scheduled:done', 'approved:current'],
            self::shape(S::APPROVED, self::changes('submitted', 'under_review', 'interview_scheduled', 'approved')),
        );
    }

    public function testRejectedHidesApprovedAndRowsThatNeverHappened(): void
    {
        $this->assertSame(['submitted:done', 'rejected:current'], self::shape(S::REJECTED, self::changes('submitted', 'rejected')));
        $this->assertSame(['submitted:done', 'under_review:done', 'withdrawn:current'], self::shape(S::WITHDRAWN, self::changes('submitted', 'under_review', 'withdrawn')));
    }

    public function testAfterAReplyTheCurrentUnderReviewComesAfterTheDoneMoreInfo(): void
    {
        $this->assertSame(
            ['submitted:done', 'more_info_needed:done', 'under_review:current', 'approved:pending'],
            self::shape(S::UNDER_REVIEW, self::changes('submitted', 'under_review', 'more_info_needed', 'under_review')),
        );
    }

    public function testTheCurrentRowCarriesItsDescriptionAndLabels(): void
    {
        $rows = ApplicationTimeline::rows(S::MORE_INFO_NEEDED, self::changes('submitted', 'under_review', 'more_info_needed'));
        $this->assertSame('More Info Needed', $rows[2]['label']);
        $this->assertSame(S::MORE_INFO_NEEDED->applicantDescription(), $rows[2]['description']);
        $this->assertNull($rows[0]['description']);
        $this->assertSame('2026-10-10T10:00:00+01:00', $rows[0]['at']);
        $this->assertNull($rows[3]['at']);
    }
}
