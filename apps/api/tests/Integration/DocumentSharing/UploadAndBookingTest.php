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

    // ----- Helpers -----

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
    private function upload(array $fields): array
    {
        $request = (new ServerRequestFactory())->createServerRequest('POST', '/api/portal/documents')
            ->withAttribute('customer_id', $this->P)
            ->withParsedBody($fields + ['document_type' => 'laboratory_test_report'])
            ->withUploadedFiles(['file' => $this->pdf()]);

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
