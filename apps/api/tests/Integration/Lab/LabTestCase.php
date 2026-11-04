<?php

declare(strict_types=1);

namespace App\Tests\Integration\Lab;

use App\Action\LabRequest\Doctor\CreateLabRequestAction;
use App\Action\LabRequest\Patient\AcceptLabRequestAction;
use App\Action\LabRequest\Patient\UploadLabResultAction;
use App\Domain\Document\DocumentSharingRules as Rules;
use App\Domain\Entity\Appointment;
use App\Domain\Entity\Patient;
use App\Domain\Entity\Specialist;
use App\Domain\Entity\User;
use App\Domain\Enum\AppointmentStatus;
use App\Domain\Enum\ConsultationType;
use App\Domain\Enum\SpecialistStatus;
use App\Domain\Lab\LabCatalogue;
use App\Domain\Lab\LabRequestRules;
use App\Infrastructure\Document\DocumentSharingService;
use App\Infrastructure\Email\MailService;
use App\Infrastructure\Prescription\SignatureStore;
use App\Infrastructure\Service\MedicalDocumentStorage;
use App\Tests\Integration\Lab\Support\LabHarness;
use DateTimeImmutable;
use DI\Container;
use Doctrine\DBAL\Connection;
use Doctrine\ORM\EntityManagerInterface;
use Monolog\Handler\TestHandler;
use Monolog\Logger;
use Monolog\LogRecord;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Ramsey\Uuid\Uuid;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response;
use Slim\Psr7\UploadedFile;

/**
 * Shared fixtures of the lab request integration tests (lab spec §8.1), on a
 * throw-away Postgres schema per class, rebuilt for every test:
 *
 *  - patients P (female, 30 — "Pregnant?" is asked) and Q (male);
 *  - doctors A (P: a completed consultation 3 days ago and one in 2 days; Q:
 *    a completed one), B (P: a completed one — a whole-folder holder in some
 *    tests), C (never consulted P); A has a saved signature;
 *  - doctor logins for A, B, C; staff: `labs.manage` + `monitoring.view`
 *    ($staffLabs) and `monitoring.view` only ($staffView).
 *
 * Every "request" gets a fresh container (its own EntityManager), like
 * production; their mailers share one log ({@see emails()}). Document sharing
 * is on unless a test switches it off. Skipped when the database is unreachable.
 */
abstract class LabTestCase extends TestCase
{
    protected static ?string $schema = null;

    protected static ?string $skipReason = null;

    /** @var list<Container> */
    private array $opened = [];

    /** @var list<string> */
    private array $tempFiles = [];

    private string|false $errorLog = false;

    protected TestHandler $mail;

    protected DateTimeImmutable $now;

    protected string $P = '';
    protected string $Q = '';
    protected string $A = '';
    protected string $B = '';
    protected string $C = '';
    protected string $userA = '';
    protected string $userB = '';
    protected string $userC = '';
    protected string $staffLabs = '';
    protected string $staffView = '';
    protected string $apPast = '';
    protected string $apNext = '';
    protected string $aqPast = '';
    protected string $bpPast = '';

    public static function setUpBeforeClass(): void
    {
        self::$skipReason = LabHarness::unavailableReason();
        self::$schema     = self::$skipReason === null ? LabHarness::createSchema() : null;
    }

    public static function tearDownAfterClass(): void
    {
        if (self::$schema !== null) {
            LabHarness::dropSchema(self::$schema);
            self::$schema = null;
        }
    }

    protected function setUp(): void
    {
        if (self::$skipReason !== null) {
            $this->markTestSkipped(self::$skipReason);
        }
        $_ENV['DOC_SHARING_ENABLED'] = 'true';
        $this->errorLog = ini_set('error_log', sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'lab-it-error.log');
        $this->mail     = new TestHandler();
        $this->conn()->executeStatement(
            'TRUNCATE lab_request_events, lab_request_results, lab_request_items, lab_requests, lab_request_counters,
                      document_access_log, document_access_blocks, document_access_hidden, document_access_grant_documents,
                      document_access_submissions, document_access_grants, document_access_requests, medical_documents, notifications, staff_notifications,
                      audit_events, specialist_status_events, app_settings, appointments, users, specialists, patients CASCADE',
        );
        $this->now = LabRequestRules::now();
        $this->fixtures();
    }

    protected function tearDown(): void
    {
        try {
            $store = $this->container()->get(SignatureStore::class);
            foreach ($this->conn()->fetchFirstColumn('SELECT signature_key FROM lab_requests UNION SELECT signature_key FROM specialists WHERE signature_key IS NOT NULL') as $key) {
                $store->delete((string) $key);
            }
        } catch (\Throwable) {
        }
        foreach ([$this->P, $this->Q] as $patient) {
            $dir = MedicalDocumentStorage::baseDir() . '/' . $patient;
            foreach (glob($dir . '/*') ?: [] as $file) {
                @unlink($file);
            }
            @rmdir($dir);
        }
        foreach ($this->tempFiles as $file) {
            @unlink($file);
        }
        $this->tempFiles = [];
        foreach ($this->opened as $container) {
            try {
                $container->get(EntityManagerInterface::class)->getConnection()->close();
            } catch (\Throwable) {
            }
        }
        $this->opened = [];
        $_ENV['DOC_SHARING_ENABLED'] = 'true';
        if ($this->errorLog !== false) {
            ini_set('error_log', (string) $this->errorLog);
        }
    }

    // ----- Fixtures -----

    private function fixtures(): void
    {
        $em = $this->em();
        $p  = new Patient('p-' . bin2hex(random_bytes(3)) . '@example.test', 'Pat', 'Patient');
        $p->setGender('female');
        $p->setDateOfBirth(new DateTimeImmutable('-30 years'));
        $q = new Patient('q-' . bin2hex(random_bytes(3)) . '@example.test', 'Quinn', 'Other');
        $q->setGender('male');
        $q->setDateOfBirth(new DateTimeImmutable('-55 years'));
        $em->persist($p);
        $em->persist($q);
        $doctors = [];
        foreach (['A' => 'Dr. Ada Alpha', 'B' => 'Dr. Ben Beta', 'C' => 'Dr. Cy Gamma'] as $key => $name) {
            $s = new Specialist($name, 'Cardiology');
            $s->setStatus(SpecialistStatus::APPROVED);
            $s->setSlotMinutes(30);
            $em->persist($s);
            $doctors[$key] = $s;
        }
        $em->flush();
        $this->P = $p->getId();
        $this->Q = $q->getId();
        foreach ($doctors as $key => $s) {
            $this->{$key} = $s->getId();
        }
        $this->apPast = $this->appointment($em, $p, $doctors['A'], '-3 days', [AppointmentStatus::CONFIRMED, AppointmentStatus::COMPLETED]);
        $this->apNext = $this->appointment($em, $p, $doctors['A'], '+2 days', [AppointmentStatus::CONFIRMED]);
        $this->aqPast = $this->appointment($em, $q, $doctors['A'], '-4 days', [AppointmentStatus::CONFIRMED, AppointmentStatus::COMPLETED]);
        $this->bpPast = $this->appointment($em, $p, $doctors['B'], '-5 days', [AppointmentStatus::CONFIRMED, AppointmentStatus::COMPLETED]);

        $this->userA     = $this->login($em, ['doctor'], [], $this->A);
        $this->userB     = $this->login($em, ['doctor'], [], $this->B);
        $this->userC     = $this->login($em, ['doctor'], [], $this->C);
        $this->staffLabs = $this->login($em, ['staff'], ['monitoring.view', 'labs.manage']);
        $this->staffView = $this->login($em, ['staff'], ['monitoring.view']);

        // Doctor A's saved signature.
        $store = $this->container()->get(SignatureStore::class);
        $doctors['A']->setSignatureKey($store->store($this->signaturePng(), 'signatures'));
        $em->persist($doctors['A']);
        $em->flush();
    }

    /** @param list<AppointmentStatus> $statuses */
    protected function appointment(EntityManagerInterface $em, Patient $p, Specialist $s, string $when, array $statuses): string
    {
        $at = $this->now->modify($when);
        $a  = new Appointment($p, $s, $at->setTime((int) $at->format('H'), 0), ConsultationType::VIDEO);
        foreach ($statuses as $status) {
            $a->transitionTo($status, true);
        }
        $em->persist($a);
        $em->flush();

        return $a->getId();
    }

    /** @param list<string> $roles @param list<string> $permissions */
    protected function login(EntityManagerInterface $em, array $roles, array $permissions, ?string $specialistId = null): string
    {
        $user = new User('u-' . bin2hex(random_bytes(4)) . '@example.test', 'Use', 'R');
        $user->setRoles($roles);
        $user->setPermissions($permissions);
        if ($specialistId !== null) {
            $user->setSpecialistId($specialistId);
        }
        $em->persist($user);
        $em->flush();

        return $user->getId();
    }

    protected function signaturePng(): string
    {
        $img = imagecreatetruecolor(200, 60);
        imagefill($img, 0, 0, (int) imagecolorallocate($img, 255, 255, 255));
        imageline($img, 10, 40, 190, 20, (int) imagecolorallocate($img, 10, 10, 120));
        ob_start();
        imagepng($img);

        return (string) ob_get_clean();
    }

    // ----- The lab flow -----

    /**
     * A valid send body for patient P (FBC, routine), overridden by `$over`.
     *
     * @param array<string,mixed> $over
     * @return array<string,mixed>
     */
    protected function sendBody(array $over = []): array
    {
        return $over + [
            'client_key'        => Uuid::uuid4()->toString(),
            'catalogue_version' => LabCatalogue::VERSION,
            'patient_id'        => $this->P,
            'appointment_id'    => null,
            'duplicated_from'   => null,
            'priority'          => 'routine',
            'purpose'           => 'diagnosis',
            'clinical_question' => 'Suspected iron-deficiency anaemia',
            'history'           => 'Fatigue for 3 weeks',
            'medication'        => 'Paracetamol',
            'allergies'         => 'Penicillin',
            'clinical'          => ['fasting' => false, 'fasting_hours' => null, 'pregnant' => false, 'weeks_pregnant' => null, 'infection_alerts' => ['hiv'], 'transfusion_3m' => false],
            'items'             => [['code' => 'FBC', 'specimen_mode' => 'auto']],
            'imaging_safety'    => null,
            'attest'            => true,
            'signature'         => ['mode' => 'saved'],
        ];
    }

    /** @param array<string,mixed> $over @return array{status:int, body:array<string,mixed>} */
    protected function send(array $over = [], ?string $user = null): array
    {
        $res = $this->doctorAction(CreateLabRequestAction::class, $user ?? $this->userA, [], $this->sendBody($over));
        unset($res['response']);

        return $res;
    }

    /** Send a request for P and return its id. @param array<string,mixed> $over */
    protected function sent(array $over = []): string
    {
        $res = $this->send($over);
        $this->assertSame(201, $res['status'], json_encode($res['body']));

        return (string) $res['body']['data']['id'];
    }

    /** @param array<string,mixed> $over @return array{status:int, body:array<string,mixed>} */
    protected function accept(string $labId, array $over = [], ?string $customer = null): array
    {
        return $this->patientAction(AcceptLabRequestAction::class, $customer ?? $this->P, $over + [
            'consent_version'  => LabRequestRules::CONSENT_VERSION,
            'agree_tests'      => true,
            'agree_pays_lab'   => true,
            'agree_disclosure' => true,
            'share_results'    => true,
        ], ['labId' => $labId]);
    }

    /** A sent and accepted request of P's. @param array<string,mixed> $send @param array<string,mixed> $accept */
    protected function booked(array $send = [], array $accept = []): string
    {
        $id  = $this->sent($send);
        $res = $this->accept($id, $accept);
        $this->assertSame(200, $res['status'], json_encode($res['body']));

        return $id;
    }

    /**
     * Upload a result as patient P.
     *
     * @param array<string,mixed> $fields
     * @return array{status:int, body:array<string,mixed>}
     */
    protected function upload(string $labId, ?UploadedFile $file = null, array $fields = [], ?string $customer = null): array
    {
        $request = (new ServerRequestFactory())->createServerRequest('POST', '/api/test')
            ->withAttribute('customer_id', $customer ?? $this->P)
            ->withParsedBody($fields);
        if ($file !== null || !array_key_exists('no_file', $fields)) {
            $request = $request->withUploadedFiles(['file' => $file ?? $this->pdf()]);
        }

        return $this->decode($this->container()->get(UploadLabResultAction::class)($request, new Response(), ['labId' => $labId]));
    }

    protected function pdf(string $name = 'result.pdf'): UploadedFile
    {
        return $this->file($name, "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n", 'application/pdf');
    }

    protected function docx(string $name = 'result.docx'): UploadedFile
    {
        $path = $this->tempPath();
        $zip  = new \ZipArchive();
        $zip->open($path, \ZipArchive::CREATE | \ZipArchive::OVERWRITE);
        $zip->addFromString('[Content_Types].xml', '<?xml version="1.0"?><Types/>');
        $zip->addFromString('word/document.xml', '<w:document/>');
        $zip->close();

        return new UploadedFile($path, $name, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', (int) filesize($path), UPLOAD_ERR_OK);
    }

    protected function file(string $name, string $bytes, string $mime): UploadedFile
    {
        $path = $this->tempPath();
        file_put_contents($path, $bytes);

        return new UploadedFile($path, $name, $mime, (int) filesize($path), UPLOAD_ERR_OK);
    }

    /** A temp PDF on disk (for worker jobs). */
    protected function pdfPath(): string
    {
        $path = $this->tempPath();
        file_put_contents($path, "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");

        return $path;
    }

    protected function tempPath(): string
    {
        $path              = (string) tempnam(sys_get_temp_dir(), 'labit');
        $this->tempFiles[] = $path;

        return $path;
    }

    /** Stored result files of a patient on disk. */
    protected function storedFiles(?string $patientId = null): int
    {
        return count(glob(MedicalDocumentStorage::baseDir() . '/' . ($patientId ?? $this->P) . '/*') ?: []);
    }

    /** Share P's whole folder with doctor `$doctorId` (no end). */
    protected function folderShare(string $doctorId, ?string $patientId = null): void
    {
        $c  = $this->container();
        $em = $c->get(EntityManagerInterface::class);
        $c->get(DocumentSharingService::class)->share($this->patient($em, $patientId ?? $this->P), [
            'specialist_ids' => [$doctorId],
            'scope'          => 'all',
            'duration'       => 'indefinite',
            'client_key'     => Uuid::uuid4()->toString(),
            'surface'        => 'manage_sharing',
        ], Rules::now());
    }

    // ----- Plumbing -----

    protected function container(): Container
    {
        $container = LabHarness::container((string) self::$schema);
        $container->set(MailService::class, new MailService('', '', '', '', new Logger('lab-mail', [$this->mail])));
        $this->opened[] = $container;

        return $container;
    }

    protected function em(): EntityManagerInterface
    {
        return $this->container()->get(EntityManagerInterface::class);
    }

    protected function conn(): Connection
    {
        return $this->em()->getConnection();
    }

    protected function patient(EntityManagerInterface $em, string $id): Patient
    {
        $p = $em->find(Patient::class, $id);
        \assert($p instanceof Patient);

        return $p;
    }

    /** The text-drawing operators of a PDF (FPDF's page streams, inflated). */
    public static function pdfText(string $pdf): string
    {
        $out = '';
        if (preg_match_all('/stream\r?\n(.*?)\r?\nendstream/s', $pdf, $m) > 0) {
            foreach ($m[1] as $stream) {
                $plain = @gzuncompress($stream);
                $out  .= ($plain !== false ? $plain : $stream) . "\n";
            }
        }

        return $out;
    }

    /** Emails "sent" (logged as skipped) with this template key. */
    protected function emails(string $template): int
    {
        return count(array_filter(
            $this->mail->getRecords(),
            static fn (LogRecord $r): bool => str_contains($r->message, 'Email skipped') && ($r->context['template'] ?? null) === $template,
        ));
    }

    /** @param list<mixed> $params */
    protected function countRows(string $sql, array $params = []): int
    {
        return (int) $this->conn()->fetchOne($sql, $params);
    }

    /**
     * Run a patient action as customer `$customerId`.
     *
     * @param array<string,mixed>  $body
     * @param array<string,string> $args
     * @param array<string,string> $query
     * @return array{status:int, body:array<string,mixed>}
     */
    protected function patientAction(string $class, string $customerId, array $body = [], array $args = [], array $query = [], string $method = 'POST'): array
    {
        $request = (new ServerRequestFactory())->createServerRequest($method, '/api/test')
            ->withAttribute('customer_id', $customerId)
            ->withParsedBody($body)
            ->withQueryParams($query);

        return $this->decode($this->container()->get($class)($request, new Response(), $args));
    }

    /**
     * Run a doctor action as staff user `$userId`.
     *
     * @param array<string,mixed>  $body
     * @param array<string,string> $args
     * @param array<string,string> $headers
     * @param array<string,string> $query
     * @return array{status:int, body:array<string,mixed>, response:ResponseInterface}
     */
    protected function doctorAction(string $class, string $userId, array $args, array $body = [], array $headers = [], string $method = 'POST', array $query = []): array
    {
        $request = (new ServerRequestFactory())->createServerRequest($method, '/api/test')
            ->withAttribute('user_id', $userId)
            ->withAttribute('user_roles', ['doctor'])
            ->withParsedBody($body)
            ->withQueryParams($query);
        foreach ($headers as $name => $value) {
            $request = $request->withHeader($name, $value);
        }
        $response = $this->container()->get($class)($request, new Response(), $args);

        return $this->decode($response) + ['response' => $response];
    }

    /**
     * Run a back-office action as staff user `$userId` with these permissions.
     *
     * @param list<string>         $permissions
     * @param array<string,mixed>  $body
     * @param array<string,string> $args
     * @return array{status:int, body:array<string,mixed>}
     */
    protected function staffAction(string $class, string $userId, array $permissions, array $args, array $body = [], string $method = 'POST'): array
    {
        $request = (new ServerRequestFactory())->createServerRequest($method, '/api/test')
            ->withAttribute('user_id', $userId)
            ->withAttribute('user_roles', ['staff'])
            ->withAttribute('user_permissions', $permissions)
            ->withParsedBody($body);

        return $this->decode($this->container()->get($class)($request, new Response(), $args));
    }

    /** @return array{status:int, body:array<string,mixed>} */
    protected function decode(ResponseInterface $response): array
    {
        $body = json_decode((string) $response->getBody(), true);

        return ['status' => $response->getStatusCode(), 'body' => is_array($body) ? $body : []];
    }

    /**
     * Hold `$labId`'s row lock in a transaction of our own, start the worker
     * jobs one after the other (each waiting on the lock before the next
     * starts, so they queue in order), run `$meanwhile($lockedConnection)`,
     * then let them go.
     *
     * @param list<array<string,mixed>> $jobs
     * @return list<array<string,mixed>>
     */
    protected function race(string $labId, array $jobs, ?callable $meanwhile = null): array
    {
        $blocker = $this->container()->get(EntityManagerInterface::class)->getConnection();
        $blocker->beginTransaction();
        $blocker->executeQuery('SELECT id FROM lab_requests WHERE id = ? FOR UPDATE', [$labId]);

        $app     = 'lab_race_' . bin2hex(random_bytes(3));
        $workers = [];
        $failure = null;
        try {
            foreach ($jobs as $n => $job) {
                $workers[] = LabHarness::startWorker($job + ['schema' => self::$schema, 'app' => $app]);
                LabHarness::awaitLockWaiters($this->em(), $app, $n + 1);
            }
            if ($meanwhile !== null) {
                $meanwhile($blocker);
            }
        } catch (\Throwable $e) {
            $failure = $e;
        }
        $blocker->commit();
        $results = array_map(static fn (array $w): array => LabHarness::finishWorker($w), $workers);
        if ($failure !== null) {
            throw new \RuntimeException($failure->getMessage() . "\nworkers: " . json_encode($results), 0, $failure);
        }

        return $results;
    }
}
