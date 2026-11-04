<?php

declare(strict_types=1);

namespace App\Tests\Integration\DocumentSharing;

use App\Action\Appointment\CreateMyAppointmentAction;
use App\Action\Appointment\UploadAppointmentDocumentAction;
use App\Action\Patient\UploadMyDocumentAction;
use App\Domain\Document\DocumentSharingRules as Rules;
use App\Domain\Entity\Specialist;
use App\Infrastructure\Service\AvailabilityService;
use App\Infrastructure\Service\MedicalDocumentStorage;
use Doctrine\ORM\EntityManagerInterface;
use Ramsey\Uuid\Uuid;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response;
use Slim\Psr7\UploadedFile;

/**
 * Uploads and bookings never share silently (spec §7.2 "Upload and booking
 * exclusions"): booking attachments are hidden from whole-folder holders by
 * default, the booking's `document_share` decides for the booked doctor and
 * the ticked others, documents-page exclusions last, batches share once, and
 * a booking that fails leaves no trace.
 */
final class UploadAndBookingTest extends DocShareTestCase
{
    /** @var list<string> */
    private array $temp = [];

    protected function tearDown(): void
    {
        foreach ($this->temp as $file) {
            @unlink($file);
        }
        foreach ([$this->P, $this->Q] as $patientId) {
            $dir = MedicalDocumentStorage::baseDir() . '/' . $patientId;
            if ($patientId !== '' && is_dir($dir)) {
                array_map('unlink', glob($dir . '/*') ?: []);
                @rmdir($dir);
            }
        }
        parent::tearDown();
    }

    public function testABookingThatKeepsFilesPrivateHidesThemFromEveryFolderHolderAndTheBookedDoctor(): void
    {
        $this->share($this->P, ['specialist_ids' => [$this->G]]);
        $doc = $this->attach();
        $res = $this->book($this->A, [$doc], ['duration' => null, 'show_specialist_ids' => []]);

        $this->assertSame(201, $res['status'], json_encode($res['body']));
        $this->assertSame('private', $res['body']['data']['document_share']['outcome']);
        $this->assertNotContains($doc, $this->visible($this->G, $this->P));
        $this->assertNotContains($doc, $this->visible($this->A, $this->P));
    }

    public function testTickingAFolderHolderShowsThemTheFiles(): void
    {
        $this->share($this->P, ['specialist_ids' => [$this->G]]);
        $doc = $this->attach([$this->G]);
        $res = $this->book($this->A, [$doc], ['duration' => null, 'show_specialist_ids' => [$this->G]]);

        $this->assertSame(201, $res['status'], json_encode($res['body']));
        $this->assertContains($doc, $this->visible($this->G, $this->P));
        $this->assertNotContains($doc, $this->visible($this->A, $this->P));
    }

    public function testBookingTheFolderHolderSharesOnlyThroughTheBookingShare(): void
    {
        $this->share($this->P, ['specialist_ids' => [$this->G]]);
        $private = $this->attach();
        $this->assertSame(201, $this->book($this->G, [$private], ['duration' => null])['status']);
        $this->assertNotContains($private, $this->visible($this->G, $this->P), 'the folder share never covers them');

        $shared = $this->attach();
        $res    = $this->book($this->G, [$shared], ['duration' => 'after_24h'], 1);
        $this->assertSame('shared', $res['body']['data']['document_share']['outcome']);
        $this->assertNotNull($res['body']['data']['document_share']['grant_id']);
        $end = new \DateTimeImmutable((string) $res['body']['data']['document_share']['until_label_at']);
        $this->assertContains($shared, $this->visible($this->G, $this->P, $end->modify('-1 minute')));
        $this->assertNotContains($shared, $this->visible($this->G, $this->P, $end->modify('+1 second')));
    }

    public function testALegacyBookingKeepsAttachmentsHiddenFromFolderHolders(): void
    {
        $this->share($this->P, ['specialist_ids' => [$this->G]]);
        $doc = $this->attach();
        $res = $this->book($this->A, [$doc], null);

        $this->assertSame(201, $res['status']);
        $this->assertSame('private', $res['body']['data']['document_share']['outcome']);
        $this->assertNotContains($doc, $this->visible($this->G, $this->P));
    }

    public function testADocumentsPageExclusionLastsThroughANewFolderShare(): void
    {
        $this->share($this->P, ['specialist_ids' => [$this->G]]);
        $up = $this->upload(['exclude_specialist_ids' => [$this->G]]);
        $this->assertSame(201, $up['status'], json_encode($up['body']));
        $doc = $up['body']['data']['id'];
        $this->assertSame('private', $up['body']['data']['share_outcome']);
        $this->assertNotContains($doc, $this->visible($this->G, $this->P));

        [$svc, $em] = $this->request();
        $svc->revokeAll($this->patient($em, $this->P), $this->now);
        $this->share($this->P, ['specialist_ids' => [$this->G]], $this->now->modify('+1 minute'));
        $this->assertNotContains($doc, $this->visible($this->G, $this->P, $this->now->modify('+2 minutes')));
        $this->assertContains($this->P1, $this->visible($this->G, $this->P, $this->now->modify('+2 minutes')));
    }

    public function testOneBatchMakesOneShareAndOneNoticeAndAnEndedBatchStoresPrivately(): void
    {
        $batch = Uuid::uuid4()->toString();
        $share = ['share_specialist_ids' => [$this->A], 'share_duration' => '7d', 'share_batch_id' => $batch];
        $ids   = [];
        foreach ([1, 2, 3] as $i) {
            $up = $this->upload($share);
            $this->assertSame(201, $up['status'], json_encode($up['body']));
            $this->assertSame('shared', $up['body']['data']['share_outcome']);
            $ids[] = $up['body']['data']['id'];
        }
        $this->assertSame(1, $this->countRows("SELECT COUNT(*) FROM document_access_grants WHERE source = 'upload'"));
        $this->assertSame(3, $this->countRows('SELECT COUNT(*) FROM document_access_grant_documents'));
        $this->assertSame(1, $this->countRows("SELECT COUNT(*) FROM staff_notifications WHERE type = 'document_access' AND user_id = ?", [$this->userA]));
        // The upload action stamped the grant with the wall clock (starts_at),
        // which may be a second past this test's fixed `now`: look at it now.
        $wallClock = Rules::now();
        foreach ($ids as $id) {
            $this->assertContains($id, $this->visible($this->A, $this->P, $wallClock));
        }

        // The batch share is stopped; the next file of the batch is kept, privately.
        $grant = (string) $this->conn()->fetchOne("SELECT id FROM document_access_grants WHERE source = 'upload'");
        [$svc, $em] = $this->request();
        $svc->revokeGrant($this->patient($em, $this->P), $grant, $this->now);
        $up = $this->upload($share);
        $this->assertSame(201, $up['status']);
        $this->assertSame('share_ended', $up['body']['data']['share_outcome']);
        $this->assertSame([$this->A], $up['body']['data']['share_ended_for']);
        $this->assertSame(1, $this->countRows('SELECT COUNT(*) FROM medical_documents WHERE id = ?', [$up['body']['data']['id']]));

        // Same batch id, other choices: refused before a byte is stored.
        $files = $this->countRows('SELECT COUNT(*) FROM medical_documents');
        $bad   = $this->upload(['share_specialist_ids' => [$this->A], 'share_duration' => '30d', 'share_batch_id' => $batch]);
        $this->assertSame(409, $bad['status']);
        $this->assertSame('idempotency_conflict', $bad['body']['errors']['code']);
        $this->assertSame($files, $this->countRows('SELECT COUNT(*) FROM medical_documents'));
    }

    public function testAFailedBookingLeavesNoShareNoLinkAndNoNotice(): void
    {
        $this->share($this->P, ['specialist_ids' => [$this->G]]);
        $doc = $this->attach();
        $this->conn()->executeStatement("UPDATE specialists SET consultation_fee = '5000.00' WHERE id = ?", [$this->A]);
        $hidden  = $this->countRows('SELECT COUNT(*) FROM document_access_hidden');
        $notices = $this->countRows('SELECT COUNT(*) FROM staff_notifications');

        $res = $this->book($this->A, [$doc], ['duration' => 'after_24h', 'show_specialist_ids' => [$this->G]]);
        $this->assertSame(422, $res['status'], 'an empty wallet');
        $this->assertSame(0, $this->countRows("SELECT COUNT(*) FROM document_access_grants WHERE source = 'booking'"));
        $this->assertSame(0, $this->countRows('SELECT COUNT(*) FROM medical_documents WHERE appointment_id IS NOT NULL'));
        $this->assertSame($hidden, $this->countRows('SELECT COUNT(*) FROM document_access_hidden WHERE cleared_at IS NULL'), 'no hidden-row change');
        $this->assertSame($notices, $this->countRows('SELECT COUNT(*) FROM staff_notifications'));
    }

    public function testAnInvalidBookingShareIsRefusedBeforeAnythingHappens(): void
    {
        $doc = $this->attach();
        $res = $this->book($this->A, [$doc], ['duration' => '7d']);
        $this->assertSame(422, $res['status']);
        $this->assertArrayHasKey('document_share.duration', $res['body']['errors']);
        $res = $this->book($this->A, [$doc], ['duration' => null, 'show_specialist_ids' => [$this->C]]);
        $this->assertSame(422, $res['status']);
        $this->assertArrayHasKey('show_specialist_ids.0', $res['body']['errors']);
        $this->assertSame(0, $this->countRows('SELECT COUNT(*) FROM appointments WHERE id NOT IN (?, ?, ?, ?, ?, ?)', [$this->apPast, $this->apNext, $this->aqNext, $this->bpNext, $this->gpPast, $this->dqNext]));
    }

    // ----- In-call uploads (share_surface=call) -----

    /** @return array<string,mixed> the call-share fields for A's upcoming consultation with P */
    private function callShare(array $over = []): array
    {
        return $over + [
            'share_specialist_ids' => [$this->A],
            'share_duration'       => 'indefinite',
            'share_batch_id'       => Uuid::uuid4()->toString(),
            'share_appointment_id' => $this->apNext,
            'share_surface'        => 'call',
        ];
    }

    public function testAnInCallUploadIsSharedWithThatDoctorWithNoEndDate(): void
    {
        $up = $this->upload($this->callShare());
        $this->assertSame(201, $up['status'], json_encode($up['body']));
        $this->assertSame('shared', $up['body']['data']['share_outcome']);
        $grant = $this->conn()->fetchAssociative("SELECT id, scope, source, duration, surface, appointment_id, expires_at FROM document_access_grants WHERE source = 'upload'");
        $this->assertIsArray($grant);
        $this->assertSame(['selected', 'upload', 'indefinite', 'call', strtolower($this->apNext)], [$grant['scope'], $grant['source'], $grant['duration'], $grant['surface'], strtolower((string) $grant['appointment_id'])]);
        $this->assertNull($grant['expires_at']);
        $this->assertSame(1, $this->countRows("SELECT COUNT(*) FROM document_access_log WHERE event = 'shared' AND CAST(details AS TEXT) LIKE '%\"surface\":\"call\"%'"));
        $this->assertSame(1, $this->countRows("SELECT COUNT(*) FROM audit_events WHERE action = 'document_access.granted' AND CAST(metadata AS TEXT) LIKE '%\"surface\":\"call\"%'"));
        $this->assertContains((string) $up['body']['data']['id'], $this->visible($this->A, $this->P, Rules::now()));

        // Replaying the batch with the same choices is fine; other choices are a 409.
        $batch = Uuid::uuid4()->toString();
        $this->assertSame(201, $this->upload($this->callShare(['share_batch_id' => $batch]))['status']);
        $this->assertSame(201, $this->upload($this->callShare(['share_batch_id' => $batch]))['status']);
        $clash = $this->upload($this->callShare(['share_batch_id' => $batch, 'share_appointment_id' => $this->apPast]));
        $this->assertSame(409, $clash['status'], json_encode($clash['body']));
        $this->assertSame('idempotency_conflict', $clash['body']['errors']['code']);
    }

    public function testAnIphoneVideoIsAcceptedInACall(): void
    {
        $up = $this->upload($this->callShare(), $this->file('clip.mp4', "\x00\x00\x00\x14ftypqt  \x00\x00\x00\x00qt  " . str_repeat("\x00", 64), 'video/mp4'));
        $this->assertSame(201, $up['status'], json_encode($up['body']));
        $this->assertSame('video/quicktime', $up['body']['data']['mime_type'], 'stored as sniffed');
        $this->assertSame('shared', $up['body']['data']['share_outcome']);
    }

    public function testCallRulesAreEnforced(): void
    {
        $files = $this->countRows('SELECT COUNT(*) FROM medical_documents');
        $cases = [
            'no consultation'    => [$this->callShare(['share_appointment_id' => null]), 'share_appointment_id', "Choose the consultation you're in."],
            'another doctor'     => [$this->callShare(['share_specialist_ids' => [$this->B]]), 'share_specialist_ids', "In a call you can share only with the doctor you're seeing."],
            'two doctors'        => [$this->callShare(['share_specialist_ids' => [$this->A, $this->B]]), 'share_specialist_ids', "In a call you can share only with the doctor you're seeing."],
            'an end date'        => [$this->callShare(['share_duration' => '7d']), 'share_duration', 'Files shared in a call stay shared until you stop sharing.'],
        ];
        foreach ($cases as $why => [$fields, $field, $message]) {
            $res = $this->upload(array_filter($fields, static fn ($v): bool => $v !== null));
            $this->assertSame(422, $res['status'], $why . ' ' . json_encode($res['body']));
            $this->assertSame($message, $res['body']['errors'][$field] ?? null, $why . ' ' . json_encode($res['body']));
        }

        $this->conn()->executeStatement("UPDATE appointments SET status = 'cancelled' WHERE id = ?", [$this->apNext]);
        $cancelled = $this->upload($this->callShare());
        $this->assertSame(422, $cancelled['status']);
        $this->assertSame('This consultation was cancelled.', $cancelled['body']['errors']['share_appointment_id']);
        $this->assertSame($files, $this->countRows('SELECT COUNT(*) FROM medical_documents'), 'nothing stored');
    }

    public function testOnlyTypesTheDoctorCanViewAreSharedInACall(): void
    {
        $files  = $this->countRows('SELECT COUNT(*) FROM medical_documents');
        $stored = fn (): int => count(glob(MedicalDocumentStorage::baseDir() . '/' . $this->P . '/*') ?: []);
        $before = $stored();
        $message = 'In a call you can share PDFs, photos (JPG, PNG, WEBP) and videos (MP4, WEBM).';
        foreach ([['letter.docx', "PK\x03\x04" . str_repeat("\x00", 100), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'], ['clip.mov', "\x00\x00\x00\x14ftypqt  \x00\x00\x00\x00qt  " . str_repeat("\x00", 64), 'video/quicktime']] as [$name, $bytes, $mime]) {
            $res = $this->upload($this->callShare(), $this->file($name, $bytes, $mime));
            $this->assertSame(422, $res['status'], $name);
            $this->assertSame(['file' => $message], $res['body']['errors'], $name);
        }
        $this->assertSame($files, $this->countRows('SELECT COUNT(*) FROM medical_documents'));
        $this->assertSame($before, $stored(), 'refused before a byte is stored');

        // Outside a call the same Word file is still fine (private).
        $this->assertSame(201, $this->upload([], $this->file('letter.docx', "PK\x03\x04" . str_repeat("\x00", 100), 'application/zip'))['status']);
    }

    public function testAStoredTypeTheDoctorCantViewIsRefusedAfterStoringAndTheBytesAreDeleted(): void
    {
        // The name check passes ("scan.pdf"), but what storage keeps isn't a
        // type the viewer can show. Real storage only stores a type its sniffing
        // agrees with, so stand in an upload whose name storage then reads as
        // ".docx" (PK bytes, sniffed as a zip): the second check must catch it.
        $path = tempnam(sys_get_temp_dir(), 'docshare-it-') ?: sys_get_temp_dir() . '/docshare-it-' . bin2hex(random_bytes(4));
        file_put_contents($path, "PK\x03\x04" . str_repeat("\x00", 100));
        $this->temp[] = $path;
        $file = new class ($path, 'scan.pdf', 'application/pdf', (int) filesize($path), UPLOAD_ERR_OK) extends UploadedFile {
            private int $reads = 0;

            public function getClientFilename(): ?string
            {
                return $this->reads++ === 0 ? 'scan.pdf' : 'scan.docx';
            }
        };

        $files  = $this->countRows('SELECT COUNT(*) FROM medical_documents');
        $stored = fn (): int => count(glob(MedicalDocumentStorage::baseDir() . '/' . $this->P . '/*') ?: []);
        $before = $stored();
        $res    = $this->upload($this->callShare(), $file);
        $this->assertSame(422, $res['status'], json_encode($res['body']));
        $this->assertSame(['file' => 'In a call you can share PDFs, photos (JPG, PNG, WEBP) and videos (MP4, WEBM).'], $res['body']['errors']);
        $this->assertSame($before, $stored(), 'the stored bytes are deleted');
        $this->assertFalse(is_file($path), 'the upload was stored (moved) before the refusal');
        $this->assertSame($files, $this->countRows('SELECT COUNT(*) FROM medical_documents'), 'no document row');
        $this->assertSame(0, $this->countRows("SELECT COUNT(*) FROM document_access_grants WHERE source = 'upload'"), 'no share');
    }

    public function testADoctorWhoStoppedPractisingGetsNothingAndTheBytesAreDeleted(): void
    {
        $before = count(glob(MedicalDocumentStorage::baseDir() . '/' . $this->P . '/*') ?: []);
        $this->suspend($this->A, $this->now->modify('-1 minute'));
        $res = $this->upload($this->callShare());
        $this->assertSame(422, $res['status'], json_encode($res['body']));
        $this->assertSame('doctor_unavailable', $res['body']['errors']['code'] ?? null, json_encode($res['body']));
        $this->assertSame($before, count(glob(MedicalDocumentStorage::baseDir() . '/' . $this->P . '/*') ?: []));
    }

    public function testWithSharingSwitchedOffACallUploadIsKeptPrivately(): void
    {
        $_ENV['DOC_SHARING_ENABLED'] = 'false';
        $res = $this->upload($this->callShare());
        $this->assertSame(201, $res['status'], json_encode($res['body']));
        $this->assertSame('sharing_unavailable', $res['body']['data']['share_outcome']);
        $this->assertSame(0, $this->countRows("SELECT COUNT(*) FROM document_access_grants WHERE source = 'upload'"));
    }

    // ----- Helpers -----

    private function file(string $name, string $bytes, string $mime): UploadedFile
    {
        $path = tempnam(sys_get_temp_dir(), 'docshare-it-') ?: sys_get_temp_dir() . '/docshare-it-' . bin2hex(random_bytes(4));
        file_put_contents($path, $bytes);
        $this->temp[] = $path;

        return new UploadedFile($path, $name, $mime, (int) filesize($path), UPLOAD_ERR_OK);
    }

    private function pdf(): UploadedFile
    {
        $path = tempnam(sys_get_temp_dir(), 'docshare-it-') ?: sys_get_temp_dir() . '/docshare-it-' . bin2hex(random_bytes(4));
        file_put_contents($path, "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");
        $this->temp[] = $path;

        return new UploadedFile($path, 'report.pdf', 'application/pdf', (int) filesize($path), UPLOAD_ERR_OK);
    }

    /**
     * POST /portal/documents as P.
     *
     * @param array<string,mixed> $fields
     * @return array{status:int, body:array<string,mixed>}
     */
    private function upload(array $fields, ?UploadedFile $file = null): array
    {
        $request = (new ServerRequestFactory())->createServerRequest('POST', '/api/portal/documents')
            ->withAttribute('customer_id', $this->P)
            ->withParsedBody($fields + ['document_type' => 'laboratory_test_report'])
            ->withUploadedFiles(['file' => $file ?? $this->pdf()]);

        return $this->decode($this->container()->get(UploadMyDocumentAction::class)($request, new Response()));
    }

    /** POST /portal/appointment-documents as P; returns the document id. @param list<string> $show */
    private function attach(array $show = []): string
    {
        $request = (new ServerRequestFactory())->createServerRequest('POST', '/api/portal/appointment-documents')
            ->withAttribute('customer_id', $this->P)
            ->withParsedBody($show !== [] ? ['show_specialist_ids' => $show] : [])
            ->withUploadedFiles(['document' => $this->pdf()]);
        $res = $this->decode($this->container()->get(UploadAppointmentDocumentAction::class)($request, new Response()));
        $this->assertSame(201, $res['status'], json_encode($res['body']));

        return (string) $res['body']['data']['id'];
    }

    /**
     * POST /portal/appointments as P with this doctor at one of their open times.
     *
     * @param list<string>              $documentIds
     * @param array<string,mixed>|null $share
     * @return array{status:int, body:array<string,mixed>}
     */
    private function book(string $specialistId, array $documentIds, ?array $share, int $slotIndex = 0): array
    {
        $c    = $this->container();
        $em   = $c->get(EntityManagerInterface::class);
        $s    = $em->find(Specialist::class, $specialistId);
        $slot = null;
        $seen = 0;
        foreach ($c->get(AvailabilityService::class)->availableDays($s, 7) as $day) {
            foreach ($day['slots'] as $candidate) {
                if ($seen++ === $slotIndex) {
                    $slot = $candidate['iso'];
                    break 2;
                }
            }
        }
        $this->assertNotNull($slot, 'the doctor has an open time');
        $body = ['specialist_id' => $specialistId, 'scheduled_at' => $slot, 'document_ids' => $documentIds];
        if ($share !== null) {
            $body['document_share'] = $share;
        }
        $request = (new ServerRequestFactory())->createServerRequest('POST', '/api/portal/appointments')
            ->withAttribute('customer_id', $this->P)
            ->withParsedBody($body);

        return $this->decode($c->get(CreateMyAppointmentAction::class)($request, new Response()));
    }
}
