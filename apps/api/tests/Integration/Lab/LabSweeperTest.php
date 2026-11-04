<?php

declare(strict_types=1);

namespace App\Tests\Integration\Lab;

use App\Action\LabRequest\Doctor\ListDoctorLabRequestsAction;
use App\Action\LabRequest\Patient\ReportLabSampleAction;
use App\Domain\Document\DocumentSharingRules as Rules;
use App\Domain\Lab\LabRequestRules;
use App\Infrastructure\Document\DocumentSharingService;
use App\Infrastructure\Lab\LabRequestSweeper;
use DateTimeImmutable;
use DateTimeZone;
use Doctrine\ORM\EntityManagerInterface;

/**
 * The lab cron jobs (lab spec §2.6): the patient reminder (T10), the doctor's
 * "not accepted yet" (T11), the review safety net (T12 reminder while the
 * result is reviewable, the 7-day staff escalation — also for a suspended
 * doctor), the result nudge (T13) and stored expiry (T9) — each once, on the
 * process clock.
 */
final class LabSweeperTest extends LabTestCase
{
    public function testThePatientIsRemindedOnceOnThePrioritysClock(): void
    {
        $stat    = $this->sent(['priority' => 'stat']);
        $urgent  = $this->sent(['priority' => 'urgent']);
        $routine = $this->sent();
        $this->ago($stat, ['sent_at' => '-119 minutes']);
        $this->ago($urgent, ['sent_at' => '-11 hours']);
        $this->ago($routine, ['sent_at' => '-47 hours']);
        $this->assertSame(0, $this->sweep()['reminded'], 'not before');

        $this->ago($stat, ['sent_at' => '-121 minutes']);
        $this->ago($urgent, ['sent_at' => '-721 minutes']);
        $this->ago($routine, ['sent_at' => '-49 hours', 'last_activity_at' => '-49 hours']);
        $this->assertSame(3, $this->sweep()['reminded']);
        $this->assertGreaterThan(Rules::sql(LabRequestRules::now()->modify('-1 hour')), (string) $this->conn()->fetchOne('SELECT last_activity_at FROM lab_requests WHERE id = ?', [$routine]), 'the reminded event bumps the list order');
        $this->assertSame(3, $this->countRows("SELECT COUNT(*) FROM notifications WHERE title = 'Lab request waiting'"));
        $this->assertSame(3, $this->emails('lab_request_reminder'));
        $this->assertSame(3, $this->countRows("SELECT COUNT(*) FROM lab_request_events WHERE event = 'reminded'"));
        $this->assertSame(0, $this->sweep()['reminded'], 'not twice');
    }

    public function testTheDoctorHearsOfAnUnacceptedStatOrUrgentRequestOnly(): void
    {
        $stat    = $this->sent(['priority' => 'stat']);
        $urgent  = $this->sent(['priority' => 'urgent']);
        $routine = $this->sent();
        $this->ago($stat, ['sent_at' => '-3 hours']);
        $this->ago($urgent, ['sent_at' => '-23 hours']);
        $this->ago($routine, ['sent_at' => '-200 hours']);
        $this->assertSame(0, $this->sweep()['doctor_nudged']);
        $this->ago($stat, ['sent_at' => '-241 minutes']);
        $this->ago($urgent, ['sent_at' => '-1441 minutes']);
        $this->assertSame(2, $this->sweep()['doctor_nudged'], 'never routine');
        $this->assertSame(2, $this->countRows("SELECT COUNT(*) FROM staff_notifications WHERE title = 'Lab request not accepted yet'"));
        $this->assertSame(0, $this->sweep()['doctor_nudged']);
    }

    public function testTheReviewReminderGoesOncePerReviewableResult(): void
    {
        $stat    = $this->booked(['priority' => 'stat']);
        $routine = $this->booked();
        $s       = $this->upload($stat)['body']['data']['result']['id'];
        $r       = $this->upload($routine)['body']['data']['result']['id'];
        $this->resultAgo($s, '-3 hours');
        $this->resultAgo($r, '-47 hours');
        $this->assertSame(0, $this->sweep()['review_reminded']);

        $this->resultAgo($s, '-5 hours');
        $this->resultAgo($r, '-49 hours');
        $this->assertSame(2, $this->sweep()['review_reminded']);
        $this->assertSame(2, $this->countRows("SELECT COUNT(*) FROM staff_notifications WHERE title = 'Result waiting for your review'"));
        $this->assertSame(2, $this->emails('lab_review_reminder'));
        $this->assertSame(0, $this->sweep()['review_reminded'], 'once');
    }

    public function testAResultTheDoctorCantOpenIsNotRemindedButStillEscalates(): void
    {
        $id     = $this->booked();
        $result = $this->upload($id)['body']['data']['result']['id'];
        $c      = $this->container();
        $c->get(DocumentSharingService::class)->stopSharing($this->patient($c->get(EntityManagerInterface::class), $this->P), $this->A, Rules::now());
        $this->resultAgo($result, '-6 days');
        $this->assertSame(0, $this->sweep()['review_reminded'], 'not reviewable now');
        $this->assertNull($this->conn()->fetchOne('SELECT review_reminded_at FROM lab_request_results WHERE id = ?', [$result]), 'left for later');

        $this->resultAgo($result, '-8 days');
        $this->assertSame(1, $this->sweep()['escalated']);
        $this->assertSame(0, $this->sweep()['escalated'], 'once');
    }

    public function testTheEscalationReachesLabsManageStaffAlsoForASuspendedDoctor(): void
    {
        $id     = $this->booked();
        $result = $this->upload($id)['body']['data']['result']['id'];
        $this->conn()->executeStatement("UPDATE specialists SET status = 'suspended', suspended_at = ? WHERE id = ?", [Rules::sql(Rules::now()), $this->A]);
        $this->resultAgo($result, '-8 days');
        $run = $this->sweep();
        $this->assertSame(0, $run['review_reminded'], 'a suspended doctor can\'t review');
        $this->assertSame(1, $run['escalated']);
        $note = $this->conn()->fetchAssociative("SELECT user_id, body, link FROM staff_notifications WHERE title = 'Lab result not reviewed'");
        $this->assertSame($this->staffLabs, $note['user_id'], 'labs.manage only');
        $number = (string) $this->conn()->fetchOne('SELECT number FROM lab_requests WHERE id = ?', [$id]);
        $this->assertSame('Lab request ' . $number . ' has a result waiting more than 7 days.', $note['body']);
        $this->assertSame('/patients/' . $this->P, $note['link']);
        $meta = json_decode((string) $this->conn()->fetchOne("SELECT CAST(metadata AS TEXT) FROM audit_events WHERE action = 'lab_result.review_escalated'"), true);
        $this->assertSame(['number', 'result_id', 'patient_id'], array_keys($meta));
    }

    public function testPrivateResultsNeverRemindOrEscalate(): void
    {
        $id     = $this->booked();
        $result = $this->upload($id, null, ['share' => '0'])['body']['data']['result']['id'];
        $this->resultAgo($result, '-9 days');
        $run = $this->sweep();
        $this->assertSame([0, 0], [$run['review_reminded'], $run['escalated']]);
    }

    public function testThePatientIsNudgedOnceWhenNoResultFollowsTheSample(): void
    {
        $routine = $this->booked();
        $stat    = $this->booked(['priority' => 'stat']);
        foreach ([$routine, $stat] as $id) {
            $this->patientAction(ReportLabSampleAction::class, $this->P, [], ['labId' => $id]);
        }
        $this->ago($routine, ['sample_at' => '-6 days']);
        $this->ago($stat, ['sample_at' => '-1 day']);
        $this->assertSame(0, $this->sweep()['result_nudged']);
        $this->ago($routine, ['sample_at' => '-8 days']);
        $this->ago($stat, ['sample_at' => '-49 hours']);
        $this->assertSame(2, $this->sweep()['result_nudged']);
        $this->assertSame(2, $this->countRows("SELECT COUNT(*) FROM notifications WHERE title = 'Waiting for your result?'"));
        $this->assertSame(0, $this->sweep()['result_nudged']);
    }

    public function testExpiryIsStoredForUnansweredAndBookedRequestsAndAnOldBacklogQuietly(): void
    {
        $awaiting = $this->sent();
        $booked   = $this->booked();
        $inLab    = $this->booked();
        $this->patientAction(ReportLabSampleAction::class, $this->P, [], ['labId' => $inLab]);
        $this->ago($awaiting, ['expires_at' => '-1 hour']);
        $this->ago($booked, ['expires_at' => '-5 days']);
        $this->ago($inLab, ['expires_at' => '-5 days']);

        $this->assertSame(2, $this->sweep()['expired']);
        $statuses = $this->conn()->fetchAllKeyValue('SELECT id, status FROM lab_requests');
        $this->assertSame('expired', $statuses[$awaiting]);
        $this->assertSame('expired', $statuses[$booked]);
        $this->assertSame('in_lab', $statuses[$inLab], 'in the lab never expires');
        $this->assertSame(1, $this->countRows("SELECT COUNT(*) FROM notifications WHERE title = 'Lab request expired'"), 'the 5-day-old one expired quietly');
        $this->assertSame(1, $this->countRows("SELECT COUNT(*) FROM staff_notifications WHERE title = 'Lab request expired'"));
        $this->assertSame(2, $this->countRows("SELECT COUNT(*) FROM lab_request_events WHERE event = 'expired' AND actor_role = 'system'"));
        $this->assertSame(0, $this->sweep()['expired'], 'idempotent');
    }

    public function testOnTheProcessClockInAnotherZone(): void
    {
        $zone = date_default_timezone_get();
        date_default_timezone_set('PRC');
        try {
            $id  = $this->sent();
            $dto = $this->doctorAction(\App\Action\LabRequest\Doctor\GetDoctorLabRequestAction::class, $this->userA, ['labId' => $id], [], [], 'GET')['body']['data'];
            $row = $this->conn()->fetchAssociative('SELECT sent_at, expires_at FROM lab_requests WHERE id = ?', [$id]);
            $this->assertSame((new DateTimeImmutable($dto['sent_at']))->setTimezone(new DateTimeZone('PRC'))->format('Y-m-d H:i:s'), (string) $row['sent_at'], 'stored on the process clock');
            $this->assertSame((new DateTimeImmutable($dto['expires_at']))->setTimezone(new DateTimeZone('PRC'))->format('Y-m-d H:i:s'), (string) $row['expires_at']);
            $this->assertSame(1, $this->doctorAction(ListDoctorLabRequestsAction::class, $this->userA, [], [], [], 'GET', ['group' => 'awaiting_patient'])['body']['meta']['counts']['awaiting_patient']);

            $this->ago($id, ['sent_at' => '-49 hours']);
            $utc = new DateTimeImmutable('@' . time()); // a client's UTC instant
            $run = $this->container()->get(LabRequestSweeper::class)->run($utc);
            $this->assertSame(1, $run['reminded']);
            $this->ago($id, ['expires_at' => '-1 minute']);
            $this->assertSame(0, $this->doctorAction(ListDoctorLabRequestsAction::class, $this->userA, [], [], [], 'GET', ['group' => 'awaiting_patient'])['body']['meta']['counts']['awaiting_patient'], 'expired on read');
            $this->assertSame(1, $this->container()->get(LabRequestSweeper::class)->run($utc)['expired']);
        } finally {
            date_default_timezone_set($zone);
        }
    }

    // ----- helpers -----

    /** @return array<string,int> */
    private function sweep(): array
    {
        return $this->container()->get(LabRequestSweeper::class)->run();
    }

    /** Set request instants relative to now (process clock). @param array<string,string> $columns column => "-N unit" */
    private function ago(string $id, array $columns): void
    {
        foreach ($columns as $column => $offset) {
            $this->conn()->executeStatement('UPDATE lab_requests SET ' . $column . ' = ? WHERE id = ?', [Rules::sql(LabRequestRules::now()->modify($offset)), $id]);
        }
    }

    private function resultAgo(string $resultId, string $offset): void
    {
        $this->conn()->executeStatement('UPDATE lab_request_results SET uploaded_at = ? WHERE id = ?', [Rules::sql(LabRequestRules::now()->modify($offset)), $resultId]);
    }
}
