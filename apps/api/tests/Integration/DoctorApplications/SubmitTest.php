<?php

declare(strict_types=1);

namespace App\Tests\Integration\DoctorApplications;

use App\Domain\Entity\Specialist;
use App\Domain\Entity\User;
use App\Domain\Enum\SpecialistStatus;
use App\Infrastructure\Persistence\RawIndexes;
use App\Tests\Integration\DoctorApplications\Support\ApplicationsHarness as H;

/** Spec §3.2.15, §3.6, D10: submit — gates, reference, idempotency, conflicts after verification, the race. */
final class SubmitTest extends DoctorApplicationsTestCase
{
    public function testIncompleteThenUnverifiedThenSubmitted(): void
    {
        $d = $this->createDraft('ng');
        $incomplete = $this->http('POST', '/api/public/doctor-applications/drafts/current/submit', [], $d['token']);
        $this->assertCode($incomplete, 422, 'incomplete');
        $this->assertSame(['professional', 'licence', 'qualifications', 'documents', 'indemnity', 'consent'], $incomplete['body']['errors']['steps']);

        $this->fillDraft($d['token'], 'ng');
        $this->assertCode($this->http('POST', '/api/public/doctor-applications/drafts/current/submit', [], $d['token']), 409, 'email_unverified');

        $sent = $this->http('POST', '/api/public/doctor-applications/drafts/current/email-code', [], $d['token']);
        $this->assertCode($sent, 202);
        $this->assertSame('ada***@example.com', $sent['body']['data']['sent_to']);
        $code  = (string) $sent['body']['data']['dev_code'];
        $wrong = $code === '000000' ? '111111' : '000000';
        $bad   = $this->http('POST', '/api/public/doctor-applications/drafts/current/email-verify', ['code' => $wrong], $d['token']);
        $this->assertCode($bad, 422, 'code_invalid');
        $this->assertSame(4, $bad['body']['errors']['attempts_left']);
        $this->assertCode($this->http('POST', '/api/public/doctor-applications/drafts/current/email-code', [], $d['token']), 429, 'resend_cooldown');
        $this->assertCode($this->http('POST', '/api/public/doctor-applications/drafts/current/email-verify', ['code' => $code], $d['token']), 200);

        $res = $this->http('POST', '/api/public/doctor-applications/drafts/current/submit', [], $d['token']);
        $this->assertCode($res, 200);
        $data = $res['body']['data'];
        $this->assertMatchesRegularExpression('/^GVM-DR-\d{4}-\d{5}$/', $data['reference']);
        $this->assertSame('submitted', $data['status']);
        $this->assertSame('ada.obi@example.com', $data['email']);
        $this->assertSame('+2348031234567', $data['phone']);
        $row = $this->conn()->fetchAssociative('SELECT status, awaiting_staff, draft_code_hash, resume_token_hash, draft_expires_at FROM doctor_applications');
        $this->assertSame(['status' => 'submitted', 'awaiting_staff' => true, 'draft_code_hash' => null, 'resume_token_hash' => null, 'draft_expires_at' => null], $row);
        $this->assertSame(1, $this->rows("SELECT COUNT(*) FROM doctor_application_events WHERE kind = 'submitted' AND applicant_visible"));
        $this->assertSame(1, $this->rows("SELECT COUNT(*) FROM audit_events WHERE action = 'doctor_application.submitted'"));

        // Idempotent replay; every other draft route is closed now.
        $again = $this->http('POST', '/api/public/doctor-applications/drafts/current/submit', [], $d['token']);
        $this->assertCode($again, 200);
        $this->assertSame($data['reference'], $again['body']['data']['reference']);
        $closed = $this->http('GET', '/api/public/doctor-applications/drafts/current', null, $d['token']);
        $this->assertCode($closed, 409, 'draft_submitted');
        $this->assertSame($data['reference'], $closed['body']['errors']['reference']);
    }

    public function testConflictsAreRevealedOnlyAfterVerification(): void
    {
        $this->submitted('ng', 'dup@example.com');

        $second = $this->createDraft('ng', 'dup@example.com');
        $this->assertArrayNotHasKey('errors', $second['body'], 'creating a draft never reveals other applications');
        $this->fillDraft($second['token'], 'ng');
        $this->assertCode($this->http('POST', '/api/public/doctor-applications/drafts/current/submit', [], $second['token']), 409, 'email_unverified', 'not before the email is proven');
        $this->verifyEmail($second['token']);
        $this->assertCode($this->http('POST', '/api/public/doctor-applications/drafts/current/submit', [], $second['token']), 409, 'duplicate_open_application');
    }

    public function testAlreadyRegisteredForADoctorLoginOrAProfile(): void
    {
        $em   = $this->em();
        $user = new User('doctor@example.com', 'Doc', 'Tor');
        $user->setRoles(['doctor']);
        $em->persist($user);
        $s = new Specialist('Dr. Profile Only', 'Cardiology');
        $s->setEmail('profile@example.com');
        $em->persist($s);
        $r = new Specialist('Dr. Rejected', 'Cardiology');
        $r->setEmail('rejected@example.com');
        $r->setStatus(SpecialistStatus::REJECTED);
        $em->persist($r);
        $em->flush();

        foreach (['doctor@example.com' => 409, 'Profile@Example.com' => 409, 'rejected@example.com' => 200] as $email => $status) {
            $d = $this->createDraft('ng', strtolower($email));
            $this->fillDraft($d['token'], 'ng');
            $this->verifyEmail($d['token']);
            $res = $this->http('POST', '/api/public/doctor-applications/drafts/current/submit', [], $d['token']);
            $this->assertCode($res, $status, $status === 409 ? 'already_registered' : null, $email);
        }
    }

    public function testThePartialUniqueIndexExists(): void
    {
        $this->assertTrue(RawIndexes::exists($this->conn(), RawIndexes::APPLICATION_OPEN_EMAIL));
        $def = (string) $this->conn()->fetchOne('SELECT indexdef FROM pg_indexes WHERE indexname = ?', [RawIndexes::APPLICATION_OPEN_EMAIL]);
        $this->assertStringContainsString('UNIQUE', $def);
        $this->assertStringContainsString('more_info_needed', $def);
    }

    public function testTwoConcurrentSubmitsOfOneDraftAnswerTheSameReference(): void
    {
        $d = $this->createDraft('ng', 'race@example.com');
        $this->fillDraft($d['token'], 'ng');
        $this->verifyEmail($d['token']);

        $observer = $this->em();
        $observer->getConnection()->executeStatement('SELECT pg_advisory_lock(' . 0x0DA2 . ', hashtext(?))', ['race@example.com']);
        $job     = ['schema' => self::$schema, 'app' => 'docapp_submit', 'method' => 'POST', 'path' => '/api/public/doctor-applications/drafts/current/submit', 'body' => [], 'token' => $d['token']];
        $workers = [H::startWorker('submit-worker.php', $job), H::startWorker('submit-worker.php', $job)];
        try {
            H::awaitLockWaiters($observer, 'docapp_submit', 2);
        } finally {
            $observer->getConnection()->executeStatement('SELECT pg_advisory_unlock(' . 0x0DA2 . ', hashtext(?))', ['race@example.com']);
        }
        $results = array_map(static fn (array $w): array => H::finishWorker($w), $workers);

        foreach ($results as $r) {
            $this->assertSame(200, $r['status'] ?? null, json_encode($results));
        }
        $this->assertSame($results[0]['body']['data']['reference'], $results[1]['body']['data']['reference']);
        $this->assertSame(1, $this->rows("SELECT COUNT(*) FROM doctor_application_events WHERE kind = 'submitted'"));
    }
}
