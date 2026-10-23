<?php

declare(strict_types=1);

namespace App\Tests\Integration\DoctorApplications;

use App\Domain\Entity\PayoutAccount;
use App\Domain\Entity\Specialist;
use App\Domain\Entity\User;
use App\Domain\Settings\PractitionerTerms;
use App\Domain\Settings\ClinicTime;
use App\Infrastructure\Service\AuthService;
use App\Tests\Integration\DoctorApplications\Support\ApplicationsHarness as H;
use DI\Container;
use Doctrine\DBAL\Connection;
use Doctrine\ORM\EntityManagerInterface;
use PHPUnit\Framework\TestCase;

/**
 * Shared plumbing of the doctor-application integration tests (spec §9.2): a
 * throw-away Postgres schema per class, wiped before each test; fresh Redis
 * counters per test; real HTTP requests; helpers that walk an applicant
 * through the wizard, submit, check the status, and act as a reviewer.
 * Skipped (not failed) when the local database is unreachable.
 */
abstract class DoctorApplicationsTestCase extends TestCase
{
    protected static ?string $schema = null;

    protected static ?string $skipReason = null;

    /** @var list<string> */
    private array $tempFiles = [];

    private string|false $errorLog = false;

    public static function setUpBeforeClass(): void
    {
        self::$skipReason = H::unavailableReason();
        self::$schema     = self::$skipReason === null ? H::createSchema() : null;
    }

    public static function tearDownAfterClass(): void
    {
        if (self::$schema !== null) {
            H::dropSchema(self::$schema);
            self::$schema = null;
        }
        H::$redisPrefix = null;
        H::$logger      = null;
    }

    protected function setUp(): void
    {
        if (self::$skipReason !== null) {
            $this->markTestSkipped(self::$skipReason);
        }
        $this->errorLog = ini_set('error_log', sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'docapp-it-error.log');
        H::$redisPrefix = 'docapp_it:' . bin2hex(random_bytes(6)) . ':';
        $this->conn()->executeStatement(
            'TRUNCATE doctor_applications, doctor_application_documents, doctor_application_events, doctor_application_info_requests,
                      doctor_application_notes, specialist_credentials, specialist_status_events, staff_notifications, staff_sessions,
                      audit_events, users, specialists, reference_items, payout_accounts, availability_slots CASCADE',
        );
    }

    protected function tearDown(): void
    {
        foreach ($this->tempFiles as $file) {
            @unlink($file);
        }
        $this->tempFiles = [];
        if ($this->errorLog !== false) {
            ini_set('error_log', (string) $this->errorLog);
        }
    }

    // ----- Plumbing -----

    /** New Redis counters and cooldowns (as if the windows had passed). */
    protected function freshCounters(): void
    {
        H::$redisPrefix = 'docapp_it:' . bin2hex(random_bytes(6)) . ':';
    }

    protected function container(): Container
    {
        return H::container((string) self::$schema);
    }

    protected function em(): EntityManagerInterface
    {
        return $this->container()->get(EntityManagerInterface::class);
    }

    protected function conn(): Connection
    {
        return $this->em()->getConnection();
    }

    /** @return array{status:int, body:array<string,mixed>, response:\Psr\Http\Message\ResponseInterface} */
    protected function http(string $method, string $path, ?array $body = null, ?string $token = null, ?array $file = null, array $headers = []): array
    {
        return H::http((string) self::$schema, $method, $path, $body, $token, $file, $headers);
    }

    /** @param list<mixed> $params */
    protected function rows(string $sql, array $params = []): int
    {
        return (int) $this->conn()->fetchOne($sql, $params);
    }

    protected function assertCode(array $res, int $status, ?string $code = null, string $message = ''): void
    {
        $this->assertSame($status, $res['status'], $message . ' ' . json_encode($res['body']));
        if ($code !== null) {
            $this->assertSame($code, $res['body']['errors']['code'] ?? null, $message . ' ' . json_encode($res['body']));
        }
    }

    // ----- Files -----

    /** A real (tiny) PDF on disk. @return array{path:string, name:string, mime:string} */
    protected function pdf(string $name = 'document.pdf', int $padTo = 0): array
    {
        $bytes = "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n";
        if ($padTo > strlen($bytes)) {
            $bytes .= str_repeat('%', $padTo - strlen($bytes));
        }
        $path = tempnam(sys_get_temp_dir(), 'docapp');
        file_put_contents($path, $bytes);
        $this->tempFiles[] = $path;

        return ['path' => $path, 'name' => $name, 'mime' => 'application/pdf'];
    }

    // ----- The applicant -----

    protected static function plusDays(int $days): string
    {
        return ClinicTime::now()->modify(($days >= 0 ? '+' : '') . $days . ' days')->format('Y-m-d');
    }

    /** @return array<string,mixed> */
    protected static function personal(string $email = 'ada.obi@example.com', string $phone = '+2348031234567'): array
    {
        return [
            'first_name' => 'Ada', 'last_name' => 'Obi', 'email' => $email, 'phone' => $phone,
            'date_of_birth' => '1985-03-12', 'gender' => 'female', 'country_of_residence' => 'NG', 'city' => 'Lagos',
        ];
    }

    /** @return array<string, array<string,mixed>> section => values */
    protected static function sections(string $route): array
    {
        return [
            'professional'   => ['specialty' => 'Cardiology', 'years_experience' => 12, 'workplace' => null, 'languages' => ['English', 'Yoruba'], 'bio' => 'Consultant cardiologist with twelve years of practice in Lagos.'],
            'licence'        => $route === 'abroad'
                ? ['regulator_country' => 'GB', 'regulator_name' => 'General Medical Council', 'registration_number' => '7012345', 'good_standing_issued_on' => self::plusDays(-30)]
                : ['mdcn_number' => 'MDCN/12345', 'full_registration_year' => 2012, 'licence_expires_on' => self::plusDays(300)],
            'qualifications' => ['entries' => [['degree' => 'MBBS', 'institution' => 'University of Lagos', 'year_awarded' => 2010]]],
            'indemnity'      => ['provider' => 'Medical Defence Union', 'policy_number' => 'MDU-2026/00123', 'cover_expires_on' => self::plusDays(250)],
            'consent'        => ['accept_terms' => true, 'authorise_verification' => true, 'confirm_accurate' => true, 'signature_name' => 'Ada Obi', 'consent_version' => '2026-10'],
        ];
    }

    /** POST /drafts. @return array{token:string, draft:array<string,mixed>, body:array<string,mixed>} */
    protected function createDraft(string $route = 'ng', string $email = 'ada.obi@example.com', bool $partial = false): array
    {
        $res = $this->http('POST', '/api/public/doctor-applications/drafts', ['licence_route' => $route, 'personal' => self::personal($email), 'partial' => $partial]);
        $this->assertCode($res, 201, null, 'create draft');

        return ['token' => (string) $res['body']['data']['draft_token'], 'draft' => $res['body']['data']['draft'], 'body' => $res['body']['data']];
    }

    /** Every remaining section and document. @return array<string,mixed> the draft */
    protected function fillDraft(string $token, string $route): array
    {
        foreach (self::sections($route) as $section => $values) {
            $res = $this->http('PUT', '/api/public/doctor-applications/drafts/current/sections/' . $section, ['values' => $values], $token);
            $this->assertCode($res, 200, null, "save {$section}");
        }
        foreach (\App\Domain\Application\ApplicationDocuments::requiredFor($route) as $slot) {
            $this->assertCode($this->upload($token, $slot), 201, null, "upload {$slot}");
        }
        $draft = $this->http('GET', '/api/public/doctor-applications/drafts/current', null, $token)['body']['data'];
        $this->assertSame('review', $draft['next_step'], json_encode($draft['steps']));

        return $draft;
    }

    /** @return array{status:int, body:array<string,mixed>} */
    protected function upload(string $token, string $slot, ?array $file = null, bool $info = false): array
    {
        $path = $info ? '/api/public/doctor-applications/track/info-response/documents' : '/api/public/doctor-applications/drafts/current/documents';

        return $this->http('POST', $path, ['slot' => $slot], $token, $file ?? $this->pdf($slot . '.pdf'));
    }

    protected function verifyEmail(string $token): void
    {
        $sent = $this->http('POST', '/api/public/doctor-applications/drafts/current/email-code', [], $token);
        if ($sent['status'] === 200) {
            return; // already verified
        }
        $this->assertCode($sent, 202, null, 'email code');
        $this->assertCode($this->http('POST', '/api/public/doctor-applications/drafts/current/email-verify', ['code' => $sent['body']['data']['dev_code']], $token), 200, null, 'verify');
    }

    /** A complete, verified, submitted application. @return array{token:string, id:string, reference:string, email:string} */
    protected function submitted(string $route = 'ng', string $email = 'ada.obi@example.com'): array
    {
        $draft = $this->createDraft($route, $email);
        $this->fillDraft($draft['token'], $route);
        $this->verifyEmail($draft['token']);
        $res = $this->http('POST', '/api/public/doctor-applications/drafts/current/submit', [], $draft['token']);
        $this->assertCode($res, 200, null, 'submit');

        return ['token' => $draft['token'], 'id' => (string) $res['body']['data']['id'], 'reference' => (string) $res['body']['data']['reference'], 'email' => $email];
    }

    /** Through the status check (by email): the access token. */
    protected function trackToken(string $reference, string $contact): string
    {
        $start = $this->http('POST', '/api/public/doctor-applications/track/start', ['reference' => $reference, 'contact' => $contact]);
        $this->assertCode($start, 200);
        $tid  = (string) $start['body']['data']['track_id'];
        $code = $this->http('POST', '/api/public/doctor-applications/track/request-code', ['track_id' => $tid, 'channel' => 'email']);
        $this->assertCode($code, 202);
        $this->assertNotNull($code['body']['data']['dev_code'] ?? null, 'a match gets a code');
        $verify = $this->http('POST', '/api/public/doctor-applications/track/verify', ['track_id' => $tid, 'code' => $code['body']['data']['dev_code']]);
        $this->assertCode($verify, 200);

        return (string) $verify['body']['data']['access_token'];
    }

    // ----- The reviewer -----

    /** A signed-in staff user. @param list<string> $permissions @return array{token:string, id:string} */
    protected function staff(array $permissions = ['specialists.manage'], string $email = 'reviewer@videomed.test'): array
    {
        $c    = $this->container();
        $em   = $c->get(EntityManagerInterface::class);
        $user = new User($email, 'Rita', 'Reviewer');
        $user->setRoles(['admin']);
        $user->setPermissions($permissions);
        $user->setPassword('password123');
        $em->persist($user);
        $em->flush();
        $tokens = $c->get(AuthService::class)->issueStaffTokens($user, 'docapp-it', '127.0.0.1');

        return ['token' => (string) $tokens['access_token'], 'id' => $user->getId()];
    }

    /** @return array{status:int, body:array<string,mixed>} */
    protected function staffCall(string $token, string $method, string $path, ?array $body = null): array
    {
        return $this->http($method, '/api/doctor-applications' . $path, $body, $token);
    }

    /** The approval body the dialog would send for this application (prefill + ticks). @return array<string,mixed> */
    protected function approveBody(string $staffToken, string $id, string $fee = '15000.00'): array
    {
        $detail = $this->staffCall($staffToken, 'GET', '/' . $id)['body']['data'];
        $docs   = [];
        foreach ($detail['approval']['documents'] as $d) {
            $docs[$d['document_id']] = [
                'checked'            => true,
                'register_reference' => $d['prefill']['register_reference'] !== '' ? $d['prefill']['register_reference'] : 'Register checked',
                'number'             => $d['prefill']['number'] ?? null,
                'issued_on'          => $d['prefill']['issued_on'] ?? null,
                'expires_on'         => $d['prefill']['expires_on'] ?? null,
            ];
        }

        return ['attest' => true, 'consultation_fee' => $fee, 'documents' => $docs, 'expected_status' => $detail['status']];
    }

    /** Submitted → under review (by a reviewer). */
    protected function underReview(string $staffToken, string $id): void
    {
        $this->assertCode($this->staffCall($staffToken, 'POST', '/' . $id . '/start-review', []), 200, null, 'start review');
    }

    /** An approved application's doctor with the whole checklist done. @return array{0:string, 1:string} [specialist id, doctor token] */
    protected function readyDoctor(string $route = 'ng', string $fee = '15000.00'): array
    {
        $app   = $this->submitted($route);
        $staff = $this->staff()['token'];
        $this->underReview($staff, $app['id']);
        $res = $this->staffCall($staff, 'POST', '/' . $app['id'] . '/approve', $this->approveBody($staff, $app['id'], $fee));
        $this->assertCode($res, 200);
        $sid = (string) $res['body']['data']['specialist_id'];

        $c  = $this->container();
        $em = $c->get(EntityManagerInterface::class);
        $s  = $em->find(Specialist::class, $sid);
        $s->setPhotoUrl('/uploads/avatars/x.jpg');
        $s->setSignatureKey('signatures/' . str_repeat('a', 32) . '.bin');
        $s->setWeeklyHours(['1' => [['09:00', '17:00']]]);
        $s->acceptTerms(PractitionerTerms::version(), '127.0.0.1');
        $em->persist(new PayoutAccount($sid));
        $em->flush();
        $user  = $em->getRepository(User::class)->findOneBy(['specialistId' => $sid]);
        $token = (string) $c->get(AuthService::class)->issueStaffTokens($user, 'docapp-it', '127.0.0.1')['access_token'];

        return [$sid, $token];
    }
}
