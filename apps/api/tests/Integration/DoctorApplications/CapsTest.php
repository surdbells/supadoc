<?php

declare(strict_types=1);

namespace App\Tests\Integration\DoctorApplications;

use App\Domain\Settings\ProcessClock;
use App\Infrastructure\Email\MailService;
use App\Tests\Integration\DoctorApplications\Support\ApplicationsHarness as H;
use Monolog\Handler\TestHandler;
use Monolog\Logger;
use Predis\Client as RedisClient;
use Ramsey\Uuid\Uuid;

/** Spec §2.3, §2.8, D31: per-email caps across drafts, per-application file caps, the global byte budget. */
final class CapsTest extends DoctorApplicationsTestCase
{
    public function testPerEmailCapsAcrossDrafts(): void
    {
        $log       = new TestHandler();
        H::$logger = new Logger('it', [$log]);
        try {
            $tokens = [];
            for ($i = 0; $i < 11; $i++) {
                $tokens[] = $this->createDraft('ng', 'capped@example.com')['token'];
            }
            // Self-service mail: at most 5 a day to the address, whatever the number of drafts.
            $hash  = MailService::toHash('capped@example.com');
            $saved = array_filter($log->getRecords(), static fn ($r): bool => ($r->context['to_hash'] ?? '') === $hash && ($r->context['template'] ?? '') === 'applicationSaved');
            $this->assertCount(5, $saved);

            // Confirm codes: 10 a day for the email across all drafts.
            foreach (array_slice($tokens, 0, 10) as $token) {
                $this->assertCode($this->http('POST', '/api/public/doctor-applications/drafts/current/email-code', [], $token), 202);
            }
            $this->assertCode($this->http('POST', '/api/public/doctor-applications/drafts/current/email-code', [], $tokens[10]), 429, 'rate_limited');
        } finally {
            H::$logger = null;
        }
    }

    public function testCreatingADraftBlocksAnImmediateResumeEmail(): void
    {
        $d = $this->createDraft('ng');
        $res = $this->http('POST', '/api/public/doctor-applications/drafts/current/resume-email', [], $d['token']);
        $this->assertCode($res, 429, 'resend_cooldown');
        $this->assertGreaterThan(0, $res['body']['errors']['retry_after']);
        $this->freshCounters();
        $ok = $this->http('POST', '/api/public/doctor-applications/drafts/current/resume-email', [], $d['token']);
        $this->assertCode($ok, 202);
        $this->assertNotSame($d['body']['dev_draft_code'], $ok['body']['data']['dev_draft_code'], 'a new code replaces the old');
        $this->assertCode($this->http('POST', '/api/public/doctor-applications/drafts/resume', ['email' => 'ada.obi@example.com', 'draft_code' => $d['body']['dev_draft_code']]), 422, 'resume_invalid');
    }

    public function testTwentyFilesAndFortyMegabytesPerApplication(): void
    {
        $d  = $this->createDraft('ng');
        $id = $d['draft']['id'];
        $insert = function (int $size) use ($id): void {
            // Timestamps on the process clock, like every stored time (never SQL now()).
            $at = ProcessClock::normalize(new \DateTimeImmutable())->format('Y-m-d H:i:s');
            $this->conn()->executeStatement(
                "INSERT INTO doctor_application_documents (id, application_id, slot, vault_key, original_name, mime, size_bytes, sha256, state, uploaded_during, created_at, updated_at)
                 VALUES (?, ?, 'additional', ?, 'x.pdf', 'application/pdf', ?, ?, 'replaced', 'draft', ?, ?)",
                [Uuid::uuid4()->toString(), $id, 'applications/' . bin2hex(random_bytes(16)) . '.bin', $size, str_repeat('a', 64), $at, $at],
            );
        };
        $insert(40 * 1024 * 1024 - 100);
        $this->assertCode($this->upload($d['token'], 'government_id', $this->pdf('id.pdf', 300)), 422, 'upload_limit', '40MB');
        $this->conn()->executeStatement('DELETE FROM doctor_application_documents');
        for ($i = 0; $i < 20; $i++) {
            $insert(10);
        }
        $this->assertCode($this->upload($d['token'], 'government_id'), 422, 'upload_limit', '20 files');
        $this->assertSame(0, (int) $this->redis()->get('onb:bytes:day'), 'a refused upload gives its bytes back');
    }

    public function testTheGlobalDailyBudget(): void
    {
        $d = $this->createDraft('ng');
        $this->redis()->set('onb:bytes:day', 2147483648, 'EX', 600);
        $res = $this->upload($d['token'], 'government_id');
        $this->assertCode($res, 503, 'storage_unavailable');
        $this->assertSame("Documents can't be uploaded right now. Please try again later.", $res['body']['message']);
        $this->assertSame(2147483648, (int) $this->redis()->get('onb:bytes:day'));
    }

    private function redis(): RedisClient
    {
        return $this->container()->get(RedisClient::class);
    }
}
