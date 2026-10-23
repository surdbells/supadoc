<?php

declare(strict_types=1);

namespace App\Tests\Integration\DoctorApplications;

/** Spec §3.2.27, §3.3.10, D22: withdraw (and reject) close the case for the reviewers. */
final class WithdrawTest extends DoctorApplicationsTestCase
{
    public function testWithdrawFromEachOpenStatusAndTheCheckbox(): void
    {
        $app    = $this->submitted('ng');
        $access = $this->trackToken($app['reference'], $app['email']);
        $this->assertCode($this->http('POST', '/api/public/doctor-applications/track/withdraw', ['confirm' => false], $access), 422);
        $this->assertCode($this->http('POST', '/api/public/doctor-applications/track/withdraw', ['confirm' => true, 'reason' => 'bored'], $access), 422);
        foreach ([['x'], 7, true] as $notAString) {
            $bad = $this->http('POST', '/api/public/doctor-applications/track/withdraw', ['confirm' => true, 'reason' => $notAString], $access);
            $this->assertCode($bad, 422, null, 'a reason that is not a string is a field error, never a 500');
            $this->assertSame('Choose a reason from the list.', $bad['body']['errors']['reason']);
        }

        $staff = $this->staff()['token'];
        $this->underReview($staff, $app['id']);
        $this->assertCode($this->staffCall($staff, 'POST', '/' . $app['id'] . '/request-info', ['message' => 'CV please', 'items' => [['kind' => 'document', 'key' => 'curriculum_vitae']]]), 200);
        $this->assertSame(0, (int) $this->staffCall($staff, 'GET', '/queue')['body']['data']['needs_action']);

        $res = $this->http('POST', '/api/public/doctor-applications/track/withdraw', ['confirm' => true, 'reason' => 'apply_later'], $access);
        $this->assertCode($res, 200);
        $this->assertSame('withdrawn', $res['body']['data']['status']);
        $this->assertFalse($res['body']['data']['can_withdraw']);
        $this->assertSame(['submitted:done', 'under_review:done', 'more_info_needed:done', 'withdrawn:current'], array_map(static fn (array $r): string => $r['key'] . ':' . $r['state'], $res['body']['data']['timeline']));
        $this->assertSame(1, $this->rows("SELECT COUNT(*) FROM doctor_application_info_requests WHERE close_reason = 'withdrawn' AND closed_at IS NOT NULL"));
        $this->assertFalse((bool) $this->conn()->fetchOne('SELECT awaiting_staff FROM doctor_applications'));
        $this->assertSame(0, (int) $this->staffCall($staff, 'GET', '/queue')['body']['data']['needs_action']);
        $this->assertSame(0, (int) $this->staffCall($staff, 'GET', '?filter=needs_action')['body']['meta']['total']);
        $detail = $this->staffCall($staff, 'GET', '/' . $app['id'])['body']['data'];
        $this->assertSame('I want to apply later', $detail['withdraw_reason_label']);
        $this->assertSame([], $detail['actions']);
        $this->assertNull($detail['approval']);
        $this->assertGreaterThanOrEqual(1, $this->rows("SELECT COUNT(*) FROM doctor_application_events WHERE kind IN ('email_sent', 'notification_failed') AND metadata::text LIKE '%applicationWithdrawn%'"), 'the email was attempted after the commit');
        $this->assertSame(1, $this->rows("SELECT COUNT(*) FROM staff_notifications WHERE title LIKE 'Application withdrawn:%'"), 'reviewers told in-app (past submitted)');

        $this->assertCode($this->http('POST', '/api/public/doctor-applications/track/withdraw', ['confirm' => true], $access), 409, 'not_allowed');

        // D16: apply again at once.
        $again = $this->createDraft('ng');
        $this->fillDraft($again['token'], 'ng');
        $this->verifyEmail($again['token']);
        $this->assertCode($this->http('POST', '/api/public/doctor-applications/drafts/current/submit', [], $again['token']), 200);
    }

    public function testRejectClosesTheRequestAndLeavesTheQueue(): void
    {
        $app   = $this->submitted('ng');
        $staff = $this->staff()['token'];
        $this->assertSame(1, (int) $this->staffCall($staff, 'GET', '/queue')['body']['data']['needs_action']);
        $this->assertCode($this->staffCall($staff, 'POST', '/' . $app['id'] . '/reject', ['reason' => '']), 422);
        $this->assertCode($this->staffCall($staff, 'POST', '/' . $app['id'] . '/reject', ['reason' => 'Licence not verifiable', 'expected_status' => 'under_review']), 409, 'status_changed');
        $res = $this->staffCall($staff, 'POST', '/' . $app['id'] . '/reject', ['reason' => 'Licence not verifiable', 'expected_status' => 'submitted']);
        $this->assertCode($res, 200);
        $this->assertSame('rejected', $res['body']['data']['status']);
        $this->assertSame('Rita Reviewer', $res['body']['data']['decided_by_name']);
        $this->assertSame(0, (int) $this->staffCall($staff, 'GET', '/queue')['body']['data']['needs_action']);
        $access = $this->trackToken($app['reference'], $app['email']);
        $status = $this->http('GET', '/api/public/doctor-applications/track/status', null, $access)['body']['data'];
        $this->assertSame('Licence not verifiable', $status['rejection_reason']);
        $this->assertSame(['submitted:done', 'rejected:current'], array_map(static fn (array $r): string => $r['key'] . ':' . $r['state'], $status['timeline']));
        $this->assertCode($this->staffCall($staff, 'POST', '/' . $app['id'] . '/start-review', []), 409, 'not_allowed');
    }
}
