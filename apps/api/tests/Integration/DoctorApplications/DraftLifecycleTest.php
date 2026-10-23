<?php

declare(strict_types=1);

namespace App\Tests\Integration\DoctorApplications;

use App\Domain\Settings\ClinicTime;

/** Spec §3.2.2–3.2.16, §2.10: drafts end to end. */
final class DraftLifecycleTest extends DoctorApplicationsTestCase
{
    public function testCreateSaveUploadReplaceDeleteAndSteps(): void
    {
        $d = $this->createDraft('ng');
        $this->assertSame('draft', $d['draft']['status']);
        $this->assertSame('ada***@example.com', $d['body']['resume_email_sent_to']);
        $this->assertSame(14400, $d['body']['expires_in']);
        $this->assertMatchesRegularExpression('/^[0-9A-HJKMNP-TV-Z]{6}$/', $d['body']['dev_draft_code']);
        $this->assertStringContainsString('/resume#t=', $d['body']['dev_resume_link']);
        $this->assertSame('complete', $d['draft']['steps']['personal']);
        $this->assertSame('professional', $d['draft']['next_step']);
        $this->assertFalse($d['draft']['email_verified']);

        $draft = $this->fillDraft($d['token'], 'ng');
        $this->assertTrue($draft['ready_to_submit']);
        $this->assertCount(6, $draft['documents']);

        // Re-uploading a slot replaces (deletes) the old document and its file.
        $first = array_values(array_filter($draft['documents'], static fn (array $x): bool => $x['slot'] === 'curriculum_vitae'))[0];
        $this->assertCode($this->upload($d['token'], 'curriculum_vitae', $this->pdf('cv-v2.pdf')), 201);
        $this->assertSame(1, $this->rows("SELECT COUNT(*) FROM doctor_application_documents WHERE slot = 'curriculum_vitae'"));
        $this->assertSame(0, $this->rows('SELECT COUNT(*) FROM doctor_application_documents WHERE id = ?', [$first['id']]));

        // Files are served to their own draft only. Picked by slot: the list is
        // ordered by a whole-second created_at, so its first row isn't stable.
        $docs = $this->http('GET', '/api/public/doctor-applications/drafts/current', null, $d['token'])['body']['data']['documents'];
        $gov  = array_values(array_filter($docs, static fn (array $x): bool => $x['slot'] === 'government_id'))[0];
        $file = $this->http('GET', '/api/public/doctor-applications/drafts/current/documents/' . $gov['id'] . '/file', null, $d['token']);
        $this->assertSame(200, $file['status']);
        $this->assertStringStartsWith('%PDF-', (string) $file['response']->getBody());
        $this->assertSame('private, no-store', $file['response']->getHeaderLine('Cache-Control'));
        $this->assertSame('nosniff', $file['response']->getHeaderLine('X-Content-Type-Options'));

        $this->assertCode($this->http('DELETE', '/api/public/doctor-applications/drafts/current/documents/' . $gov['id'], null, $d['token']), 200);
        $after = $this->http('GET', '/api/public/doctor-applications/drafts/current', null, $d['token'])['body']['data'];
        $this->assertNotSame('complete', $after['steps']['documents'], 'the documents step needs its government ID');
        $this->assertFalse($after['ready_to_submit']);
        $this->assertCode($this->http('DELETE', '/api/public/doctor-applications/drafts/current/documents/' . $gov['id'], null, $d['token']), 404);

        // A wrong slot / an unreadable file.
        $this->assertCode($this->upload($d['token'], 'good_standing_certificate'), 422, 'upload_slot_invalid');
        $txt = $this->pdf('notes.png');
        $this->assertCode($this->upload($d['token'], 'government_id', $txt), 422, 'file_invalid');
        $this->assertSame(0, $this->rows('SELECT COUNT(*) FROM doctor_application_events'), 'drafts have no events');
    }

    public function testFieldErrorsAndPartialSaves(): void
    {
        $bad = $this->http('POST', '/api/public/doctor-applications/drafts', ['licence_route' => 'ng', 'personal' => ['email' => 'nope'], 'partial' => true]);
        $this->assertCode($bad, 422);
        $this->assertSame('Enter a valid email address.', $bad['body']['errors']['email'], 'the email is needed even when partial');
        $this->assertCode($this->http('POST', '/api/public/doctor-applications/drafts', ['licence_route' => 'mars', 'personal' => self::personal()]), 422);

        $d = $this->http('POST', '/api/public/doctor-applications/drafts', ['licence_route' => 'ng', 'personal' => ['email' => 'ada@example.com'], 'partial' => true]);
        $this->assertCode($d, 201);
        $token = $d['body']['data']['draft_token'];
        $this->assertSame('incomplete', $d['body']['data']['draft']['steps']['personal']);
        $this->assertCode($this->http('PUT', '/api/public/doctor-applications/drafts/current/sections/professional', ['values' => ['bio' => 'short'], 'partial' => true], $token), 422);
        $ok = $this->http('PUT', '/api/public/doctor-applications/drafts/current/sections/professional', ['values' => ['specialty' => 'Cardiology'], 'partial' => true], $token);
        $this->assertCode($ok, 200);
        $this->assertSame('incomplete', $ok['body']['data']['steps']['professional']);
        $this->assertCode($this->http('PUT', '/api/public/doctor-applications/drafts/current/sections/consent', ['values' => ['consent_version' => '2025-01']], $token), 409, 'consent_outdated');
        $this->assertCode($this->http('PUT', '/api/public/doctor-applications/drafts/current/sections/nope', ['values' => []], $token), 404);
    }

    public function testResumeByCodeAndByLinkMarksTheEmailVerified(): void
    {
        $d = $this->createDraft('ng');
        $bad = $this->http('POST', '/api/public/doctor-applications/drafts/resume', ['email' => 'ada.obi@example.com', 'draft_code' => 'ZZZZZZ']);
        $this->assertCode($bad, 422, 'resume_invalid');
        $none = $this->http('POST', '/api/public/doctor-applications/drafts/resume', ['email' => 'nobody@example.com', 'draft_code' => 'ZZZZZZ']);
        $this->assertSame($bad['body'], $none['body'], 'the same answer whether or not the email has drafts');

        $code = strtolower(substr($d['body']['dev_draft_code'], 0, 3)) . '-' . substr($d['body']['dev_draft_code'], 3);
        $ok   = $this->http('POST', '/api/public/doctor-applications/drafts/resume', ['email' => ' ADA.OBI@example.com ', 'draft_code' => $code]);
        $this->assertCode($ok, 200);
        $this->assertTrue($ok['body']['data']['draft']['email_verified']);
        $this->assertSame($d['draft']['id'], $ok['body']['data']['draft']['id']);

        $token = substr((string) strstr($d['body']['dev_resume_link'], '#t='), 3);
        $link  = $this->http('POST', '/api/public/doctor-applications/drafts/resume-link', ['token' => $token]);
        $this->assertCode($link, 200);
        $this->assertCode($this->http('POST', '/api/public/doctor-applications/drafts/resume-link', ['token' => 'not-a-token']), 422, 'link_invalid');

        // A new resume email replaces the old link and code.
        $again = $this->http('POST', '/api/public/doctor-applications/drafts/current/resume-email', [], $link['body']['data']['draft_token']);
        $this->assertCode($again, 429, 'resend_cooldown', 'POST /drafts just sent one');
    }

    public function testChangingTheRouteClearsTheLicenceAndAnEmailChangeUnverifies(): void
    {
        $d = $this->createDraft('ng');
        $this->fillDraft($d['token'], 'ng');
        $this->verifyEmail($d['token']);
        $changed = $this->http('PATCH', '/api/public/doctor-applications/drafts/current', ['licence_route' => 'abroad'], $d['token']);
        $this->assertCode($changed, 200);
        $this->assertSame('abroad', $changed['body']['data']['licence_route']);
        $this->assertNull($changed['body']['data']['sections']['licence']);
        $this->assertSame('not_started', $changed['body']['data']['steps']['licence']);
        $this->assertSame(0, $this->rows("SELECT COUNT(*) FROM doctor_application_documents WHERE slot = 'mdcn_certificate'"));
        $this->assertSame(1, $this->rows('SELECT COUNT(*) FROM doctor_applications WHERE mdcn_number IS NULL AND licence_expires_on IS NULL'));
        $this->assertTrue($changed['body']['data']['email_verified']);

        $personal = self::personal('new.address@example.com');
        $saved    = $this->http('PUT', '/api/public/doctor-applications/drafts/current/sections/personal', ['values' => $personal], $d['token']);
        $this->assertCode($saved, 200);
        $this->assertFalse($saved['body']['data']['email_verified'], 'a new address must be confirmed again');
        $this->assertSame('new.address@example.com', $this->conn()->fetchOne('SELECT email FROM doctor_applications'));
    }

    public function testDiscardDeletesFilesAndLazyExpiryPurges(): void
    {
        $d = $this->createDraft('ng');
        $this->assertCode($this->upload($d['token'], 'government_id'), 201);
        $key = (string) $this->conn()->fetchOne('SELECT vault_key FROM doctor_application_documents');
        $vault = (string) $_ENV['DOCAPP_IT_VAULT'];
        $this->assertFileExists($vault . '/' . $key);
        $this->assertCode($this->http('DELETE', '/api/public/doctor-applications/drafts/current', null, $d['token']), 200);
        $this->assertFileDoesNotExist($vault . '/' . $key);
        $this->assertSame(0, $this->rows('SELECT COUNT(*) FROM doctor_applications'));
        $this->assertCode($this->http('GET', '/api/public/doctor-applications/drafts/current', null, $d['token']), 401, 'applicant_token_invalid', 'the token of a deleted draft');

        $e = $this->createDraft('ng', 'other@example.com');
        $this->assertCode($this->upload($e['token'], 'government_id'), 201);
        $expired = ClinicTime::now()->modify('-1 hour');
        $this->conn()->executeStatement('UPDATE doctor_applications SET draft_expires_at = ?', [$expired->setTimezone(new \DateTimeZone(date_default_timezone_get()))->format('Y-m-d H:i:s')]);
        $this->assertCode($this->http('GET', '/api/public/doctor-applications/drafts/current', null, $e['token']), 404, 'draft_not_found');
        $this->assertSame(0, $this->rows('SELECT COUNT(*) FROM doctor_applications'));
        $this->assertSame(0, $this->rows('SELECT COUNT(*) FROM doctor_application_documents'));
        $this->assertSame(0, $this->rows('SELECT COUNT(*) FROM doctor_application_events'), 'nothing left behind');
    }

    public function testConfig(): void
    {
        $res = $this->http('GET', '/api/public/doctor-applications/config');
        $this->assertCode($res, 200);
        $this->assertSame('2026-10', $res['body']['data']['consent_version']);
        $this->assertSame(5242880, $res['body']['data']['max_upload_bytes']);
        $this->assertFalse($res['body']['data']['sms_enabled']);
        $this->assertNull($res['body']['data']['legal_terms_url']);
        $this->assertSame('public, max-age=60', $res['response']->getHeaderLine('Cache-Control'));
    }
}
