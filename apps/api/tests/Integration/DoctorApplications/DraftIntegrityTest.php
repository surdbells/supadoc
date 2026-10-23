<?php

declare(strict_types=1);

namespace App\Tests\Integration\DoctorApplications;

use App\Infrastructure\Application\ApplicationCodeService;
use App\Tests\Integration\DoctorApplications\Support\ApplicationsHarness as H;
use Predis\Client as RedisClient;

/**
 * Spec D10, §3.5 #6, §3.6, D31: a proof of one address never proves another;
 * draft writes and submit see each other's commits; the mail cap never
 * strands an applicant without a working code.
 */
final class DraftIntegrityTest extends DoctorApplicationsTestCase
{
    private const DRAFTS = '/api/public/doctor-applications/drafts';

    public function testAnEmailChangeKillsEveryProofSentToTheOldAddress(): void
    {
        $this->submitted('ng', 'victim@example.com'); // the address already has an open application
        $this->freshCounters();

        $d     = $this->createDraft('ng', 'attacker@example.com');
        $token = substr((string) strstr((string) $d['body']['dev_resume_link'], '#t='), 3);
        $draft = (string) $d['body']['dev_draft_code'];
        $this->fillDraft($d['token'], 'ng');
        $code = $this->http('POST', self::DRAFTS . '/current/email-code', [], $d['token']);
        $this->assertCode($code, 202);

        $put = $this->http('PUT', self::DRAFTS . '/current/sections/personal', ['values' => self::personal('victim@example.com')], $d['token']);
        $this->assertCode($put, 200);
        $this->assertFalse($put['body']['data']['email_verified']);
        $this->assertSame([null, null], array_values($this->conn()->fetchAssociative("SELECT draft_code_hash, resume_token_hash FROM doctor_applications WHERE email = 'victim@example.com' AND status = 'draft'")));

        // The confirm code went to the old address: expired for the new one.
        $this->assertCode($this->http('POST', self::DRAFTS . '/current/email-verify', ['code' => $code['body']['data']['dev_code']], $d['token']), 422, 'code_expired');
        // The resume link and draft code went there too.
        $this->assertCode($this->http('POST', self::DRAFTS . '/resume-link', ['token' => $token]), 422, 'link_invalid');
        $this->assertCode($this->http('POST', self::DRAFTS . '/resume', ['email' => 'victim@example.com', 'draft_code' => $draft]), 422, 'resume_invalid');
        // So nothing about the victim's address is revealed: submit still wants the confirm code.
        $this->assertCode($this->http('POST', self::DRAFTS . '/current/submit', [], $d['token']), 409, 'email_unverified');
        $this->assertSame(0, (int) $this->conn()->fetchOne("SELECT COUNT(*) FROM doctor_applications WHERE email = 'victim@example.com' AND email_verified_at IS NOT NULL AND status = 'draft'"));

        // Proof now comes only from the new mailbox.
        $mail = $this->http('POST', self::DRAFTS . '/current/resume-email', [], $d['token']);
        $this->assertCode($mail, 202);
        $this->assertSame('vic***@example.com', $mail['body']['data']['sent_to']);
        $resumed = $this->http('POST', self::DRAFTS . '/resume', ['email' => 'victim@example.com', 'draft_code' => $mail['body']['data']['dev_draft_code']]);
        $this->assertCode($resumed, 200);
        $this->assertTrue($resumed['body']['data']['draft']['email_verified']);
    }

    public function testSubmitWaitingForItsLockSeesAnEmailChange(): void
    {
        $d = $this->createDraft('ng', 'first@example.com');
        $this->fillDraft($d['token'], 'ng');
        $this->verifyEmail($d['token']);

        $observer = $this->em();
        $observer->getConnection()->executeStatement('SELECT pg_advisory_lock(' . 0x0DA2 . ', hashtext(?))', ['first@example.com']);
        $worker = H::startWorker('submit-worker.php', ['schema' => self::$schema, 'app' => 'docapp_submit', 'method' => 'POST', 'path' => self::DRAFTS . '/current/submit', 'body' => [], 'token' => $d['token']]);
        try {
            H::awaitLockWaiters($observer, 'docapp_submit', 1);
            // Submit passed its checks and waits on the email lock: the address changes meanwhile.
            $this->assertCode($this->http('PUT', self::DRAFTS . '/current/sections/personal', ['values' => self::personal('second@example.com')], $d['token']), 200);
        } finally {
            $observer->getConnection()->executeStatement('SELECT pg_advisory_unlock(' . 0x0DA2 . ', hashtext(?))', ['first@example.com']);
        }
        $result = H::finishWorker($worker);

        $this->assertSame(409, $result['status'] ?? null, json_encode($result));
        $this->assertSame('status_changed', $result['body']['errors']['code'] ?? null);
        $this->assertSame(
            ['status' => 'draft', 'email' => 'second@example.com', 'email_verified_at' => null, 'reference' => null],
            $this->conn()->fetchAssociative('SELECT status, email, email_verified_at, reference FROM doctor_applications'),
        );
        $this->assertSame(0, $this->rows('SELECT COUNT(*) FROM doctor_application_events'));
    }

    public function testADraftWriteWaitingOnSubmitAnswersDraftSubmitted(): void
    {
        $d  = $this->createDraft('ng');
        $id = (string) $d['draft']['id'];
        $this->fillDraft($d['token'], 'ng');
        $this->verifyEmail($d['token']);
        $keys = $this->conn()->fetchFirstColumn('SELECT vault_key FROM doctor_application_documents');

        $observer = $this->em();
        $observer->getConnection()->executeStatement('SELECT pg_advisory_lock(' . 0x0DA1 . ', hashtext(?))', [$id]);
        $workers = [
            H::startWorker('submit-worker.php', ['schema' => self::$schema, 'app' => 'docapp_write', 'method' => 'PUT', 'path' => self::DRAFTS . '/current/sections/personal', 'body' => ['values' => self::personal('late@example.com')], 'token' => $d['token']]),
            H::startWorker('submit-worker.php', ['schema' => self::$schema, 'app' => 'docapp_write', 'method' => 'PATCH', 'path' => self::DRAFTS . '/current', 'body' => ['licence_route' => 'abroad'], 'token' => $d['token']]),
            H::startWorker('submit-worker.php', ['schema' => self::$schema, 'app' => 'docapp_write', 'method' => 'DELETE', 'path' => self::DRAFTS . '/current', 'body' => null, 'token' => $d['token']]),
        ];
        try {
            // The three writes passed the token check while it was a draft and wait for the application lock …
            H::awaitLockWaiters($observer, 'docapp_write', 3);
            // … which submit doesn't need: it commits first.
            $submit = $this->http('POST', self::DRAFTS . '/current/submit', [], $d['token']);
            $this->assertCode($submit, 200);
        } finally {
            $observer->getConnection()->executeStatement('SELECT pg_advisory_unlock(' . 0x0DA1 . ', hashtext(?))', [$id]);
        }
        $results = array_map(static fn (array $w): array => H::finishWorker($w), $workers);

        foreach ($results as $r) {
            $this->assertSame(409, $r['status'] ?? null, json_encode($results));
            $this->assertSame('draft_submitted', $r['body']['errors']['code'] ?? null);
            $this->assertSame($submit['body']['data']['reference'], $r['body']['errors']['reference'] ?? null);
        }
        $row = $this->conn()->fetchAssociative('SELECT status, email, licence_route, mdcn_number IS NOT NULL AS has_licence, draft_expires_at FROM doctor_applications');
        $this->assertSame(['status' => 'submitted', 'email' => 'ada.obi@example.com', 'licence_route' => 'ng', 'has_licence' => true, 'draft_expires_at' => null], $row, 'no late write landed on the submitted row');
        $this->assertSame(count($keys), $this->rows('SELECT COUNT(*) FROM doctor_application_documents'), 'discard kept the submitted documents');
        $vault = (string) $_ENV['DOCAPP_IT_VAULT'];
        foreach ($keys as $key) {
            $this->assertFileExists($vault . '/' . $key, 'and their files');
        }
    }

    public function testOverTheMailCapTheCodeAndLinkAlreadySentKeepWorking(): void
    {
        $d     = $this->createDraft('ng', 'capped@example.com');
        $code  = (string) $d['body']['dev_draft_code'];
        $hash  = ApplicationCodeService::emailHash('capped@example.com');
        $redis = $this->redis();
        $redis->set('onb:mail:day:' . $hash, 5, 'EX', 86400); // today's 5 emails are used up
        $redis->del(['onb:resend:' . $hash]);                   // the 60 s cooldown has passed

        // Anyone may ask for a resend: over the cap it sends nothing and rotates nothing.
        $this->assertCode($this->http('POST', self::DRAFTS . '/resend', ['email' => 'capped@example.com']), 202);
        $resumed = $this->http('POST', self::DRAFTS . '/resume', ['email' => 'capped@example.com', 'draft_code' => $code]);
        $this->assertCode($resumed, 200, null, 'the emailed code still works');

        // The applicant's own "Save & continue later": the same 202, and the same code stays valid.
        $redis->del(['onb:resend:' . $hash]);
        $own = $this->http('POST', self::DRAFTS . '/current/resume-email', [], $resumed['body']['data']['draft_token']);
        $this->assertCode($own, 202);
        $this->assertSame('cap***@example.com', $own['body']['data']['sent_to']);
        $this->assertArrayNotHasKey('dev_draft_code', $own['body']['data'], 'nothing new was issued');
        $this->assertCode($this->http('POST', self::DRAFTS . '/resume', ['email' => 'capped@example.com', 'draft_code' => $code]), 200);
        $this->assertSame(7, (int) $redis->get('onb:mail:day:' . $hash), 'one slot claimed per refused send, never two');
    }

    private function redis(): RedisClient
    {
        return $this->container()->get(RedisClient::class);
    }
}
