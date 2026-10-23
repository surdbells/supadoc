<?php

declare(strict_types=1);

namespace App\Tests\Integration\DoctorApplications;

use App\Tests\Integration\DoctorApplications\Support\ApplicationsHarness as H;
use Monolog\Handler\TestHandler;
use Monolog\Logger;

/** Spec §8: across a whole flow the app log sees no email, phone or name (mail is skipped: ZeptoMail unconfigured). */
final class PrivacyLogTest extends DoctorApplicationsTestCase
{
    public function testAFullFlowLogsNoPersonalData(): void
    {
        $log       = new TestHandler();
        H::$logger = new Logger('it', [$log]);
        try {
            $email = 'zainab.okonkwo@example.com';
            $d     = $this->http('POST', '/api/public/doctor-applications/drafts', ['licence_route' => 'ng', 'personal' => ['first_name' => 'Zainab', 'last_name' => 'Okonkwo', 'phone' => '+2348091112233'] + self::personal($email)]);
            $this->assertCode($d, 201);
            $token    = $d['body']['data']['draft_token'];
            $sections = self::sections('ng');
            $sections['consent']['signature_name'] = 'Zainab Okonkwo';
            foreach ($sections as $section => $values) {
                $this->assertCode($this->http('PUT', '/api/public/doctor-applications/drafts/current/sections/' . $section, ['values' => $values], $token), 200, null, $section);
            }
            foreach (\App\Domain\Application\ApplicationDocuments::requiredFor('ng') as $slot) {
                $this->upload($token, $slot);
            }
            $this->verifyEmail($token);
            $sub = $this->http('POST', '/api/public/doctor-applications/drafts/current/submit', [], $token);
            $this->assertCode($sub, 200);
            $id    = $sub['body']['data']['id'];
            $staff = $this->staff()['token'];
            $this->underReview($staff, $id);
            $this->staffCall($staff, 'POST', '/' . $id . '/request-info', ['message' => 'CV please', 'items' => [['kind' => 'document', 'key' => 'curriculum_vitae']]]);
            $access = $this->trackToken($sub['body']['data']['reference'], $email);
            $this->upload($access, 'curriculum_vitae', null, true);
            $this->http('POST', '/api/public/doctor-applications/track/info-response/submit', [], $access);
            $res = $this->staffCall($staff, 'POST', '/' . $id . '/approve', $this->approveBody($staff, $id));
            $this->assertCode($res, 200);
        } finally {
            H::$logger = null;
        }

        $this->assertNotEmpty($log->getRecords(), 'the skipped mails are logged (hashed)');
        foreach ($log->getRecords() as $record) {
            $dump = (string) json_encode([$record->message, $record->context, $record->extra]);
            foreach (['zainab', 'okonkwo', '8091112233', '@example.com', 'GVM-DR-'] as $leak) {
                $this->assertStringNotContainsStringIgnoringCase($leak, $dump, $record->message);
            }
        }
    }
}
