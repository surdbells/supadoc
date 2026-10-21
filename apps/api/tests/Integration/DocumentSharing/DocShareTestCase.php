<?php

declare(strict_types=1);

namespace App\Tests\Integration\DocumentSharing;

use App\Domain\Document\DocumentSharingRules as Rules;
use App\Domain\Entity\Appointment;
use App\Domain\Entity\MedicalDocument;
use App\Domain\Entity\Patient;
use App\Domain\Entity\Specialist;
use App\Domain\Entity\User;
use App\Domain\Enum\AppointmentStatus;
use App\Domain\Enum\ConsultationType;
use App\Domain\Enum\SpecialistStatus;
use App\Infrastructure\Document\DocumentAccessPolicy;
use App\Infrastructure\Document\DocumentSharingService;
use App\Infrastructure\Document\VisibleDocument;
use App\Infrastructure\Service\MedicalDocumentStorage;
use App\Tests\Integration\DocumentSharing\Support\DocShareHarness;
use DateTimeImmutable;
use DI\Container;
use Doctrine\DBAL\Connection;
use Doctrine\ORM\EntityManagerInterface;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Ramsey\Uuid\Uuid;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response;

/**
 * Shared fixtures of the document-sharing integration tests (spec §7.2), on a
 * throw-away Postgres schema per class, rebuilt for every test:
 *
 *  - patients P, Q;
 *  - doctors A (P: a completed and an upcoming consultation; Q: one), B (P: an
 *    upcoming one; suspended by some tests), C (never booked with P), D (Q
 *    only), G (P: a completed one — the folder-share holder of the booking tests);
 *  - documents P1..P3 (P's), Q1 (Q's);
 *  - doctor logins for A and D.
 *
 * Every "request" gets a fresh container (its own EntityManager and session),
 * like production. DOC_SHARING_ENABLED is on unless a test switches it off.
 * Skipped (not failed) when the local database is unreachable.
 */
abstract class DocShareTestCase extends TestCase
{
    protected static ?string $schema = null;

    protected static ?string $skipReason = null;

    /** @var list<Container> */
    private array $opened = [];

    /** @var list<string> files {@see storeBytes()} wrote, removed in tearDown */
    private array $storedFiles = [];

    protected DateTimeImmutable $now;

    private string|false $errorLog = false;

    protected string $P = '';
    protected string $Q = '';
    protected string $A = '';
    protected string $B = '';
    protected string $C = '';
    protected string $D = '';
    protected string $G = '';
    protected string $P1 = '';
    protected string $P2 = '';
    protected string $P3 = '';
    protected string $Q1 = '';
    /** A–P completed 3 days ago; A–P upcoming in 2 days; A–Q in 3 days; B–P in 4 days; G–P completed 5 days ago; D–Q in 1 day. */
    protected string $apPast = '';
    protected string $apNext = '';
    protected string $aqNext = '';
    protected string $bpNext = '';
    protected string $gpPast = '';
    protected string $dqNext = '';
    protected string $userA = '';
    protected string $userD = '';

    public static function setUpBeforeClass(): void
    {
        self::$skipReason = DocShareHarness::unavailableReason();
        self::$schema     = self::$skipReason === null ? DocShareHarness::createSchema() : null;
    }

    public static function tearDownAfterClass(): void
    {
        if (self::$schema !== null) {
            DocShareHarness::dropSchema(self::$schema);
            self::$schema = null;
        }
    }

    protected function setUp(): void
    {
        if (self::$skipReason !== null) {
            $this->markTestSkipped(self::$skipReason);
        }
        $_ENV['DOC_SHARING_ENABLED'] = 'true';
        // Fail-closed paths log on purpose; keep them out of the test output.
        $this->errorLog = ini_set('error_log', sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'docshare-it-error.log');
        $this->conn()->executeStatement(
            'TRUNCATE document_access_log, document_access_blocks, document_access_hidden, document_access_grant_documents,
                      document_access_submissions, document_access_grants, document_access_requests, medical_documents, notifications, staff_notifications,
                      audit_events, specialist_status_events, app_settings, appointments, users, specialists, patients CASCADE',
        );
        $this->now = Rules::now();
        $this->fixtures();
    }

    protected function tearDown(): void
    {
        foreach ($this->storedFiles as $file) {
            @unlink($file);
            @rmdir(dirname($file)); // only when empty
        }
        $this->storedFiles = [];
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
        $q  = new Patient('q-' . bin2hex(random_bytes(3)) . '@example.test', 'Quinn', 'Other');
        $em->persist($p);
        $em->persist($q);
        $doctors = [];
        foreach (['A' => 'Dr. Ada Alpha', 'B' => 'Dr. Ben Beta', 'C' => 'Dr. Cy Gamma', 'D' => 'Dr. Dee Delta', 'G' => 'Dr. Gil Folder'] as $key => $name) {
            $s = new Specialist($name, 'Psychiatry');
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
        $this->aqNext = $this->appointment($em, $q, $doctors['A'], '+3 days', [AppointmentStatus::CONFIRMED]);
        $this->bpNext = $this->appointment($em, $p, $doctors['B'], '+4 days', [AppointmentStatus::CONFIRMED]);
        $this->gpPast = $this->appointment($em, $p, $doctors['G'], '-5 days', [AppointmentStatus::CONFIRMED, AppointmentStatus::COMPLETED]);
        $this->dqNext = $this->appointment($em, $q, $doctors['D'], '+1 day', [AppointmentStatus::CONFIRMED]);

        $this->P1 = $this->document($em, $p->getId(), 'HIV test result', 'blood_test_report', '-3 hours');
        $this->P2 = $this->document($em, $p->getId(), 'Chest X-ray', 'xray_report', '-2 hours');
        $this->P3 = $this->document($em, $p->getId(), 'Vaccination card', 'vaccination_record', '-1 hour');
        $this->Q1 = $this->document($em, $q->getId(), 'Q private scan', 'mri_report', '-1 hour');

        $this->userA = $this->doctorLogin($em, $this->A);
        $this->userD = $this->doctorLogin($em, $this->D);
        $em->flush();
    }

    /** @param list<AppointmentStatus> $statuses */
    protected function appointment(EntityManagerInterface $em, Patient $p, Specialist $s, string $when, array $statuses): string
    {
        $a = new Appointment($p, $s, $this->now->modify($when)->setTime((int) $this->now->modify($when)->format('H'), 0), ConsultationType::VIDEO);
        foreach ($statuses as $status) {
            $a->transitionTo($status, true);
        }
        $em->persist($a);
        $em->flush();

        return $a->getId();
    }

    private function document(EntityManagerInterface $em, string $patientId, string $title, string $type, string $age): string
    {
        $doc = new MedicalDocument($patientId, MedicalDocument::UPLOADER_PATIENT, 'Pat Patient', $type, $title, bin2hex(random_bytes(8)) . '.pdf', 'application/pdf', 'pdf', 120);
        $em->persist($doc);
        $em->flush();
        $em->getConnection()->executeStatement('UPDATE medical_documents SET created_at = ? WHERE id = ?', [Rules::sql($this->now->modify($age)), $doc->getId()]);

        return $doc->getId();
    }

    /** A new document of P's, created at `$at` (default now). */
    protected function newDocument(string $patientId, string $title = 'Later upload', ?DateTimeImmutable $at = null): string
    {
        $em  = $this->em();
        $doc = new MedicalDocument($patientId, MedicalDocument::UPLOADER_PATIENT, 'Pat Patient', 'laboratory_test_report', $title, bin2hex(random_bytes(8)) . '.pdf', 'application/pdf', 'pdf', 120);
        $em->persist($doc);
        $em->flush();
        $em->getConnection()->executeStatement('UPDATE medical_documents SET created_at = ? WHERE id = ?', [Rules::sql($at ?? $this->now), $doc->getId()]);

        return $doc->getId();
    }

    /**
     * Give fixture documents real bytes in the vault, so a doctor's file view
     * gets as far as streaming (the fixtures are metadata only: a view of a
     * document with no file is refused before anything is recorded).
     */
    protected function storeBytes(string ...$documentIds): void
    {
        $c       = $this->container();
        $em      = $c->get(EntityManagerInterface::class);
        $storage = $c->get(MedicalDocumentStorage::class);
        foreach ($documentIds as $id) {
            $doc = $em->find(MedicalDocument::class, $id);
            \assert($doc instanceof MedicalDocument);
            $path = $storage->path($doc);
            if (!is_dir(dirname($path))) {
                mkdir(dirname($path), 0775, true);
            }
            file_put_contents($path, "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");
            $this->storedFiles[] = $path;
        }
    }

    private function doctorLogin(EntityManagerInterface $em, string $specialistId): string
    {
        $user = new User('doc-' . bin2hex(random_bytes(4)) . '@example.test', 'Doc', 'Tor');
        $user->setRoles(['doctor']);
        $user->setSpecialistId($specialistId);
        $em->persist($user);
        $em->flush();

        return $user->getId();
    }

    // ----- Plumbing -----

    protected function container(): Container
    {
        $container      = DocShareHarness::container((string) self::$schema);
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

    /** The sharing service and the patient / doctor entities of ONE fresh "request". @return array{0: DocumentSharingService, 1: EntityManagerInterface, 2: Container} */
    protected function request(): array
    {
        $c = $this->container();

        return [$c->get(DocumentSharingService::class), $c->get(EntityManagerInterface::class), $c];
    }

    protected function patient(EntityManagerInterface $em, string $id): Patient
    {
        $p = $em->find(Patient::class, $id);
        \assert($p instanceof Patient);

        return $p;
    }

    protected function doctor(EntityManagerInterface $em, string $id): Specialist
    {
        $s = $em->find(Specialist::class, $id);
        \assert($s instanceof Specialist);

        return $s;
    }

    /**
     * Share as patient `$patientId` (defaults: one doctor, the whole folder, no end).
     *
     * @param array<string,mixed> $input
     * @return array<string,mixed>
     */
    protected function share(string $patientId, array $input, ?DateTimeImmutable $now = null): array
    {
        [$svc, $em] = $this->request();

        return $svc->share($this->patient($em, $patientId), $input + [
            'scope'      => 'all',
            'duration'   => 'indefinite',
            'client_key' => Uuid::uuid4()->toString(),
            'surface'    => 'manage_sharing',
        ], $now ?? $this->now);
    }

    /**
     * The documents doctor `$doctorId` can see of patient `$patientId` at `$now`
     * — and the parity check: the patient-side set (gate 1 aside) is the same.
     *
     * @return list<string>
     */
    protected function visible(string $doctorId, string $patientId, ?DateTimeImmutable $now = null): array
    {
        $now ??= $this->now;
        $c      = $this->container();
        $em     = $c->get(EntityManagerInterface::class);
        $policy = $c->get(DocumentAccessPolicy::class);
        $doctor = $this->doctor($em, $doctorId);
        $p      = $this->patient($em, $patientId);
        $ids    = array_map(static fn (VisibleDocument $v): string => $v->documentId, $policy->visibleDocuments($doctor, $p, $now));
        $side   = array_map(static fn (VisibleDocument $v): string => $v->documentId, $policy->visibleByDoctor($p, $now)[strtolower($doctorId)] ?? []);
        if ($policy->isPractising($doctor)) {
            $this->assertSame($ids, $side, 'parity: the doctor list equals the patient-side set');
        } else {
            $this->assertSame([], $ids, 'gate 1: a doctor who is not practising sees nothing');
        }
        sort($ids);

        return $ids;
    }

    /** @param list<string> $ids @return list<string> */
    protected function sorted(array $ids): array
    {
        sort($ids);

        return $ids;
    }

    protected function suspend(string $specialistId, DateTimeImmutable $at): void
    {
        $this->conn()->executeStatement("UPDATE specialists SET status = 'suspended', suspended_at = ? WHERE id = ?", [Rules::sql($at), $specialistId]);
        $this->conn()->executeStatement(
            "INSERT INTO specialist_status_events (id, specialist_id, from_status, to_status, actor_id, actor_name, created_at) VALUES (?, ?, 'approved', 'suspended', NULL, 'System', ?)",
            [Uuid::uuid4()->toString(), $specialistId, Rules::sql($at)],
        );
    }

    /** @param list<mixed> $params */
    protected function countRows(string $sql, array $params = []): int
    {
        return (int) $this->conn()->fetchOne($sql, $params);
    }

    /**
     * Run a patient action (customer `$customerId`) and decode its answer.
     *
     * @param array<string,mixed> $body
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
     * @return array{status:int, body:array<string,mixed>, response:ResponseInterface}
     */
    protected function doctorAction(string $class, string $userId, array $args, array $body = [], array $headers = [], string $method = 'POST'): array
    {
        $request = (new ServerRequestFactory())->createServerRequest($method, '/api/test')
            ->withAttribute('user_id', $userId)
            ->withAttribute('user_roles', ['doctor'])
            ->withParsedBody($body);
        foreach ($headers as $name => $value) {
            $request = $request->withHeader($name, $value);
        }
        $response = $this->container()->get($class)($request, new Response(), $args);

        return $this->decode($response) + ['response' => $response];
    }

    /** @return array{status:int, body:array<string,mixed>} */
    protected function decode(ResponseInterface $response): array
    {
        $body = json_decode((string) $response->getBody(), true);

        return ['status' => $response->getStatusCode(), 'body' => is_array($body) ? $body : []];
    }
}
