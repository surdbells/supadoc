<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Action\Appointment\CreateMyAppointmentAction;
use App\Action\Appointment\UploadAppointmentDocumentAction;
use App\Action\Patient\ListMyDocumentsAction;
use App\Domain\Document\BookingAttachments;
use App\Domain\Document\DocumentType;
use App\Domain\Entity\Appointment;
use App\Domain\Entity\MedicalDocument;
use App\Domain\Entity\Patient;
use App\Domain\Entity\Specialist;
use App\Domain\Repository\MedicalDocumentRepository;
use App\Domain\Repository\PatientRepository;
use App\Infrastructure\Persistence\DoctrineEntityManagerFactory;
use App\Infrastructure\Service\DocumentRejectedException;
use App\Infrastructure\Service\DocumentStorageException;
use App\Infrastructure\Service\MedicalDocumentStorage;
use DateTimeImmutable;
use Doctrine\ORM\EntityManagerInterface;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Slim\Psr7\Factory\ResponseFactory;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\UploadedFile;

/**
 * Booking attachments are private medical documents: filed through
 * MedicalDocumentStorage (never the public web root), labelled as Booking
 * Attachments, linked to the appointment by a nullable SET NULL association,
 * and attached to a booking only by id, at most 10 at a time.
 */
final class BookingAttachmentsTest extends TestCase
{
    /** A 1×1 lossless WEBP — the old booking upload accepted these. */
    private const WEBP = 'UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==';

    /** A document id that, in these tests, is someone else's. */
    private const OTHER = '9A2B4C6D-8E0F-4A1B-8C3D-5E7F9A1B3C5D';

    /** Files these tests wrote, removed afterwards. */
    private array $cleanup = [];

    protected function tearDown(): void
    {
        foreach ($this->cleanup as $path) {
            if (is_file($path)) {
                @unlink($path);
            }
        }
        foreach (glob(MedicalDocumentStorage::baseDir() . '/test-*', GLOB_ONLYDIR) ?: [] as $dir) {
            @rmdir($dir);
        }
    }

    private function em(): EntityManagerInterface
    {
        $_ENV['DB_SERVER_VERSION'] = '16';
        DoctrineEntityManagerFactory::reset();

        return DoctrineEntityManagerFactory::create();
    }

    private function tempFile(string $bytes): string
    {
        $path = (string) tempnam(sys_get_temp_dir(), 'att');
        file_put_contents($path, $bytes);
        $this->cleanup[] = $path;

        return $path;
    }

    // ----- Type + mapping -----

    public function testBookingAttachmentIsLabelledButNeverOfferedAsAType(): void
    {
        self::assertSame('Booking Attachment', DocumentType::label(DocumentType::BOOKING_ATTACHMENT));
        // A patient can't pick it on the Documents page, and the upload rejects it.
        self::assertFalse(DocumentType::isValid(DocumentType::BOOKING_ATTACHMENT));
        self::assertNotContains(DocumentType::BOOKING_ATTACHMENT, array_column(DocumentType::all(), 'value'));
    }

    public function testTheAppointmentLinkIsANullableIndexedSetNullAssociation(): void
    {
        $meta   = $this->em()->getClassMetadata(MedicalDocument::class);
        $assoc  = $meta->getAssociationMapping('appointment');
        $column = $assoc->joinColumns[0];

        self::assertSame(Appointment::class, $assoc->targetEntity);
        self::assertSame('appointment_id', $column->name);
        self::assertTrue($column->nullable);
        self::assertSame('SET NULL', $column->onDelete);
        self::assertSame(['appointment_id'], $meta->table['indexes']['idx_med_docs_appointment']['columns'] ?? null);
    }

    public function testTheDocumentSerialisesItsAppointmentId(): void
    {
        $patient     = new Patient('ada@example.test', 'Ada', 'Obi');
        $appointment = new Appointment($patient, new Specialist('Dr. Grace Bell', 'General Practice'), new DateTimeImmutable('+1 day'));
        $document    = new MedicalDocument($patient->getId(), MedicalDocument::UPLOADER_PATIENT, 'Ada Obi', DocumentType::BOOKING_ATTACHMENT, 'Scan', 's.png', 'image/png', 'png', 100);
        $document->initTimestamps();

        self::assertNull($document->toArray()['appointment_id']);
        self::assertSame('Booking Attachment', $document->toArray()['type_label']);

        $document->setAppointment($appointment);
        self::assertSame($appointment->getId(), $document->getAppointmentId());
        self::assertSame($appointment->getId(), $document->toArray()['appointment_id']);
    }

    public function testTheAppointmentFilterAndTheAttachmentQueriesCompile(): void
    {
        $repo = new MedicalDocumentRepository($this->em());
        $id   = '00000000-0000-0000-0000-000000000000';

        $filtered = $repo->filteredForPatient('p1', null, null, $id)->getQuery()->getSQL();
        self::assertStringContainsStringIgnoringCase('appointment_id = ?', $filtered);
        self::assertStringContainsStringIgnoringCase('patient_id = ?', $filtered);

        // The lookup only ever sees the caller's own documents.
        $states = $repo->attachmentStatesQuery('p1', [$id])->getSQL();
        self::assertStringContainsStringIgnoringCase('patient_id = ?', $states);
        self::assertStringContainsStringIgnoringCase(' IN (', $states);

        // The link is guarded in the UPDATE itself, so of two bookings racing for
        // one file only one can take it (the caller checks the row count).
        $attach = $repo->attachQuery($id, 'p1', [$id])->getSQL();
        self::assertStringStartsWith('UPDATE medical_documents SET appointment_id = ?', $attach);
        self::assertStringContainsStringIgnoringCase('patient_id = ?', $attach);
        self::assertStringContainsStringIgnoringCase('appointment_id IS NULL', $attach);
    }

    public function testTheListRejectsAMalformedAppointmentFilter(): void
    {
        $action  = new ListMyDocumentsAction(new MedicalDocumentRepository($this->em()));
        $request = (new ServerRequestFactory())
            ->createServerRequest('GET', '/api/portal/documents')
            ->withAttribute('customer_id', 'p1')
            ->withQueryParams(['appointment_id' => 'not-a-uuid']);

        $res  = $action($request, (new ResponseFactory())->createResponse());
        $body = json_decode((string) $res->getBody(), true);

        // 422 before any query runs (a non-uuid would be a 500 on Postgres).
        self::assertSame(422, $res->getStatusCode());
        self::assertSame('Invalid appointment id', $body['errors']['appointment_id']);
    }

    // ----- Upload -----

    public function testUploadWithoutAFileIs422(): void
    {
        $res  = $this->upload(null);
        $body = json_decode((string) $res->getBody(), true);

        self::assertSame(422, $res->getStatusCode());
        self::assertSame('Attach a file to upload', $body['errors']['document']);
    }

    public function testUploadRunsTheMedicalDocumentChecks(): void
    {
        // Text named .png: refused by content, before anything is stored.
        $file = new UploadedFile($this->tempFile('not really an image'), 'scan.png', 'image/png', 19, UPLOAD_ERR_OK);
        $res  = $this->upload($file);
        $body = json_decode((string) $res->getBody(), true);

        self::assertSame(422, $res->getStatusCode());
        self::assertSame('The file content does not match its extension', $body['errors']['document']);
        self::assertDirectoryDoesNotExist(MedicalDocumentStorage::baseDir() . '/test-patient');
    }

    public function testAStorageFaultIsALogged500ThatNamesNoServerPath(): void
    {
        // A read-only FILE where the patient's folder should be: the file passes
        // every check, then can't be written.
        if (!is_dir(MedicalDocumentStorage::baseDir())) {
            mkdir(MedicalDocumentStorage::baseDir(), 0o775, true);
        }
        $blocker = MedicalDocumentStorage::baseDir() . '/test-blocked';
        file_put_contents($blocker, '');
        chmod($blocker, 0o444);
        $log         = $this->tempFile('');
        $previousLog = ini_set('error_log', $log);

        try {
            $file = new UploadedFile($this->tempFile((string) base64_decode(self::WEBP)), 'scan.webp', 'image/webp', 38, UPLOAD_ERR_OK);
            $res  = $this->upload($file, 'test-blocked');
        } finally {
            ini_set('error_log', (string) $previousLog);
            chmod($blocker, 0o644);
            @unlink($blocker);
        }
        $body = json_decode((string) $res->getBody(), true);

        // Not a 422 showing the storage error to the patient: a 500, logged.
        self::assertSame(500, $res->getStatusCode());
        self::assertSame('Could not save the file. Please try again.', $body['message']);
        self::assertStringNotContainsString('medical-docs', (string) $res->getBody());
        self::assertStringContainsString('[appointment-documents] storage failed', (string) file_get_contents($log));
    }

    // ----- Legacy import (bin/prod-migrate.php step 7) -----

    public function testImportCopiesALegacyWebpIntoPrivateStorage(): void
    {
        // Named like a legacy attachment: the extension comes from the file name.
        $source = sys_get_temp_dir() . '/test-patient-0a1b2c3d.webp';
        file_put_contents($source, (string) base64_decode(self::WEBP));
        $this->cleanup[] = $source;
        $storage = new MedicalDocumentStorage();
        $meta    = $storage->import($source, 'test-patient', 'Booking attachment');

        $document = new MedicalDocument('test-patient', MedicalDocument::UPLOADER_PATIENT, 'Ada', DocumentType::BOOKING_ATTACHMENT, $meta['title'], $meta['stored_name'], $meta['mime'], $meta['extension'], $meta['size']);
        $this->cleanup[] = $storage->path($document);

        self::assertSame('webp', $meta['extension']);
        self::assertSame('image/webp', $meta['mime']);
        self::assertSame('Booking attachment', $meta['title']);
        self::assertTrue($storage->exists($document), 'copied into var/medical-docs');
        self::assertStringNotContainsString('/public/', str_replace('\\', '/', $storage->path($document)));
        self::assertFileExists($source, 'a copy leaves the source (a file\'s last import moves it instead)');
    }

    public function testImportRefusesMissingOrMislabelledFiles(): void
    {
        $storage = new MedicalDocumentStorage();

        try {
            $storage->checkImport(sys_get_temp_dir() . '/no-such-file.pdf');
            self::fail('a missing file must be refused');
        } catch (DocumentRejectedException $e) {
            self::assertSame('The file is missing or unreadable', $e->getMessage());
        }

        $fake = $this->tempFile('plain text');
        rename($fake, $fake . '.png');
        $this->cleanup[] = $fake . '.png';
        $this->expectException(DocumentRejectedException::class);
        $this->expectExceptionMessage('The file content does not match its extension');
        $storage->checkImport($fake . '.png');
    }

    public function testAStorageFaultIsNeverReadAsARejection(): void
    {
        // Callers show any RuntimeException from the storage as a 422 with its
        // message; a write fault names server paths, so it must not be one.
        self::assertTrue(is_a(DocumentRejectedException::class, \RuntimeException::class, true));
        self::assertFalse(is_a(DocumentStorageException::class, \RuntimeException::class, true));
    }

    // ----- Attaching to a booking -----

    public function testABookingTakesAtMostTenDocuments(): void
    {
        $ids  = array_map(static fn (int $i): string => sprintf('00000000-0000-4000-8000-%012d', $i), range(1, CreateMyAppointmentAction::MAX_DOCUMENTS + 1));
        $body = json_decode((string) $this->book(['document_ids' => $ids])->getBody(), true);

        self::assertSame('You can attach at most ' . CreateMyAppointmentAction::MAX_DOCUMENTS . ' documents', $body['errors']['document_ids']);
    }

    public function testABookingRejectsAMalformedDocumentId(): void
    {
        $res  = $this->book(['document_ids' => ['6f1c3a52-1b1e-4c55-9d2b-0c8e5b0f6a11', 'nope', 42]]);
        $body = json_decode((string) $res->getBody(), true);

        self::assertSame(422, $res->getStatusCode());
        self::assertArrayNotHasKey('document_ids.0', $body['errors']);
        self::assertSame('Invalid document id', $body['errors']['document_ids.1']);
        self::assertSame('Invalid document id', $body['errors']['document_ids.2']);
    }

    public function testDocumentIdsAreNormalisedAndAnOlderClientsUrlStillCounts(): void
    {
        $parse = new \ReflectionMethod(CreateMyAppointmentAction::class, 'parseDocumentIds');
        $make  = (new \ReflectionClass(CreateMyAppointmentAction::class))->newInstanceWithoutConstructor();
        $id    = '6f1c3a52-1b1e-4c55-9d2b-0c8e5b0f6a11';

        self::assertSame([[$id], []], $parse->invoke($make, [strtoupper($id), $id], null), 'case-folded, duplicates collapse');
        self::assertSame([[], []], $parse->invoke($make, null, null));
        // The upload's `url` (the authenticated route), sent back by an older client.
        self::assertSame([[$id], []], $parse->invoke($make, null, '/api/portal/documents/' . $id . '/file'));
        // The old public paths are never accepted any more.
        self::assertSame([[], []], $parse->invoke($make, null, '/uploads/appointment-docs/x.png'));
        self::assertSame([[], ['document_ids' => 'Invalid document list']], $parse->invoke($make, 'abc', null));
        // Shaped like a uuid but not one: never reaches the uuid column (a 500 on Postgres).
        self::assertSame([[], []], $parse->invoke($make, null, '/api/portal/documents/' . str_repeat('-', 36) . '/file'));
        // Each id keeps its position in the request, past a bad entry or a repeat.
        self::assertSame(
            [[1 => $id, 3 => strtolower(self::OTHER)], ['document_ids.0' => 'Invalid document id']],
            $parse->invoke($make, ['nope', $id, $id, self::OTHER], null),
        );
    }

    // ----- Who may attach what -----

    public function testOnlyThePatientsOwnUnattachedDocumentsCanBeAttached(): void
    {
        $own   = '6f1c3a52-1b1e-4c55-9d2b-0c8e5b0f6a11';
        $taken = '6f1c3a52-1b1e-4c55-9d2b-0c8e5b0f6a12';
        $other = strtolower(self::OTHER);
        // Request positions 0, 2 and 3 (1 was a repeat). The lookup only returns
        // the caller's own documents, so another patient's is simply absent.
        $ids    = [0 => $own, 2 => $taken, 3 => $other];
        $states = [$own => null, $taken => '0d6c7e1a-3b5f-4c2e-9a8d-1f2e3d4c5b6a'];

        self::assertSame([
            'document_ids.2' => BookingAttachments::TAKEN,
            'document_ids.3' => BookingAttachments::NOT_FOUND,
        ], BookingAttachments::problems($ids, $states));
        // Another patient's id reads exactly like one that doesn't exist.
        self::assertSame(
            BookingAttachments::problems([0 => $other], []),
            BookingAttachments::problems([0 => '00000000-0000-4000-8000-000000000000'], []),
        );
        self::assertSame([], BookingAttachments::problems([0 => $own], [$own => null]));
        self::assertSame([], BookingAttachments::problems([], []));
    }

    /** Runs the upload action as patient `$patientId` (found without a database). */
    private function upload(?UploadedFile $file, string $patientId = 'test-patient'): ResponseInterface
    {
        $em      = $this->em();
        $patient = new Patient('ada@example.test', 'Ada', 'Obi');
        (new \ReflectionProperty(Patient::class, 'id'))->setValue($patient, $patientId);
        $em->getUnitOfWork()->registerManaged($patient, ['id' => $patientId], []);

        $action  = new UploadAppointmentDocumentAction(
            new PatientRepository($em),
            new MedicalDocumentRepository($em),
            new MedicalDocumentStorage(),
        );
        $request = (new ServerRequestFactory())
            ->createServerRequest('POST', '/api/portal/appointment-documents')
            ->withAttribute('customer_id', $patientId)
            ->withUploadedFiles($file !== null ? ['document' => $file] : []);

        return $action($request, (new ResponseFactory())->createResponse());
    }

    /** Runs the booking action up to its validation (nothing past it is reached). */
    private function book(array $fields): ResponseInterface
    {
        $action  = (new \ReflectionClass(CreateMyAppointmentAction::class))->newInstanceWithoutConstructor();
        $request = (new ServerRequestFactory())
            ->createServerRequest('POST', '/api/portal/appointments')
            ->withAttribute('customer_id', 'p1')
            ->withParsedBody($fields + [
                'specialist_id' => '6f1c3a52-1b1e-4c55-9d2b-0c8e5b0f6a12',
                'scheduled_at'  => (new DateTimeImmutable('+2 days'))->format(DATE_ATOM),
            ]);

        return $action($request, (new ResponseFactory())->createResponse());
    }
}
