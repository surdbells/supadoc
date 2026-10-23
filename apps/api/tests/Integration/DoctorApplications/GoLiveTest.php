<?php

declare(strict_types=1);

namespace App\Tests\Integration\DoctorApplications;

use App\Domain\Entity\Specialist;

/** Spec §4.6, §4.8: an application doctor finishes setup and presses "Go live". */
final class GoLiveTest extends DoctorApplicationsTestCase
{
    public function testAReadyDoctorGoesLiveAtOnce(): void
    {
        [$sid, $token] = $this->readyDoctor();
        $before = $this->http('GET', '/api/doctor/onboarding', null, $token)['body']['data'];
        $this->assertTrue($before['go_live_on_submit']);
        $this->assertSame('ng', $before['licence_route']);
        $this->assertNotNull($before['application']['reference']);
        $this->assertTrue($before['complete'], json_encode($before['checklist']));

        $res = $this->http('POST', '/api/doctor/onboarding/submit', [], $token);
        $this->assertCode($res, 200);
        $this->assertSame("You're live. Patients can now find and book you.", $res['body']['message']);
        $this->assertSame('approved', $res['body']['data']['status']);
        $s = $this->em()->find(Specialist::class, $sid);
        $this->assertTrue($s->isBookable());
        $this->assertNotNull($s->getApprovedSnapshot(), 'the legacy cron never flags them');
        $this->assertNotNull($s->getLicenceExpiresAt());
        $this->assertSame(1, $this->rows("SELECT COUNT(*) FROM specialist_status_events WHERE code = 'went_live'"));
        $this->assertSame(1, $this->rows("SELECT COUNT(*) FROM audit_events WHERE action = 'specialist.went_live'"));
    }

    public function testAZeroFeeOrAPendingChangeFallsBackToReview(): void
    {
        [$sid, $token] = $this->readyDoctor();
        $this->conn()->executeStatement("UPDATE specialists SET consultation_fee = '0.00' WHERE id = ?", [$sid]);
        $res = $this->http('POST', '/api/doctor/onboarding/submit', [], $token);
        $this->assertCode($res, 200);
        $this->assertSame('pending_review', $res['body']['data']['status']);
        $this->assertStringContainsString('quick final check', $res['body']['message']);
        $meta = json_decode((string) $this->conn()->fetchOne("SELECT metadata FROM audit_events WHERE action = 'specialist.submitted'"), true);
        $this->assertContains('fee', $meta['go_live_blocked']);

        $this->setUp();
        [$sid2, $token2] = $this->readyDoctor();
        $edit = $this->http('PATCH', '/api/doctor/profile', ['name' => 'Dr. Ada Obi-Okafor'], $token2);
        $this->assertCode($edit, 200);
        $this->assertStringContainsString('sent for review', $edit['body']['message'], 'identity is locked from the start');
        $res = $this->http('POST', '/api/doctor/onboarding/submit', [], $token2);
        $this->assertSame('pending_review', $res['body']['data']['status']);
    }
}
