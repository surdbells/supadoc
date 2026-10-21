<?php

declare(strict_types=1);

namespace App\Tests\Integration\DocumentSharing;

use App\Action\Doctor\DoctorDocumentAccessAction;
use App\Action\Doctor\DownloadPatientDocumentAction;
use App\Action\DocumentSharing\GetAppointmentDocumentAccessAction;
use App\Action\DocumentSharing\ListDocumentAccessHistoryAction;
use App\Action\DocumentSharing\ListSharingDoctorsAction;
use App\Action\Patient\ListMyDocumentsAction;
use App\Domain\Document\DocumentSharingRules as Rules;
use App\Domain\Repository\DocumentAccessLogRepository;
use Ramsey\Uuid\Uuid;

/**
 * Audit trail and the patient's ledger (spec §7.2 "Audit and ledger"): one
 * audit row per write with no title anywhere, every file view recorded before
 * a byte is streamed (503 and nothing streamed when it can't be), passive
 * polls never audited, and ledger titles only from the patient's own documents.
 */
final class AuditAndLedgerTest extends DocShareTestCase
{
    public function testEveryWriteIsAuditedOnceAndNoAuditOrLedgerRowNamesADocument(): void
    {
        $grant = $this->share($this->P, ['specialist_ids' => [$this->A], 'scope' => 'selected', 'document_ids' => [$this->P1]])['grants'][0]['id'];
        $this->assertSame(1, $this->countRows("SELECT COUNT(*) FROM audit_events WHERE action = 'document_access.granted'"));
        [$svc, $em] = $this->request();
        $svc->updateGrant($this->patient($em, $this->P), $grant, ['add_document_ids' => [$this->P2]], $this->now);
        $this->assertSame(1, $this->countRows("SELECT COUNT(*) FROM audit_events WHERE action = 'document_access.changed'"));
        [$svc, $em] = $this->request();
        $svc->revokeGrant($this->patient($em, $this->P), $grant, $this->now);
        $this->assertSame(1, $this->countRows("SELECT COUNT(*) FROM audit_events WHERE action = 'document_access.revoked'"));

        foreach ($this->conn()->fetchFirstColumn('SELECT CAST(metadata AS TEXT) FROM audit_events') as $metadata) {
            foreach (['HIV', 'Chest X-ray', 'blood_test_report', 'xray_report', 'Psychiatry'] as $phi) {
                $this->assertStringNotContainsString($phi, (string) $metadata);
            }
        }
        foreach ($this->conn()->fetchFirstColumn('SELECT CAST(details AS TEXT) FROM document_access_log WHERE details IS NOT NULL') as $details) {
            $this->assertStringNotContainsString('HIV', (string) $details);
        }
        foreach ($this->conn()->fetchFirstColumn('SELECT title || body FROM staff_notifications') as $text) {
            $this->assertStringNotContainsString('HIV', (string) $text);
        }
    }

    public function testEveryFileViewIsRecordedWithNoCoalescing(): void
    {
        $this->share($this->P, ['specialist_ids' => [$this->A]]);
        $this->storeBytes($this->P1);
        foreach ([1, 2] as $i) {
            $res = $this->doctorAction(DownloadPatientDocumentAction::class, $this->userA, ['id' => $this->apNext, 'docId' => $this->P1], method: 'GET');
            $this->assertSame(200, $res['status'], "view $i is streamed");
            $this->assertSame('application/pdf', $res['response']->getHeaderLine('Content-Type'));
        }
        $this->assertSame(2, $this->countRows("SELECT COUNT(*) FROM document_access_log WHERE event = 'viewed' AND document_id = ?", [$this->P1]));
        $this->assertSame(2, $this->countRows("SELECT COUNT(*) FROM audit_events WHERE action = 'document.viewed'"));
        $this->assertSame(2, $this->countRows('SELECT SUM(access_count) FROM document_access_grants'));
        $this->assertSame(0, $this->countRows("SELECT COUNT(*) FROM audit_events WHERE action = 'document.viewed' AND CAST(metadata AS TEXT) LIKE '%HIV%'"));
    }

    public function testAViewOfADocumentWhoseFileIsMissingRecordsNothing(): void
    {
        $this->share($this->P, ['specialist_ids' => [$this->A]]);
        $audits = $this->countRows('SELECT COUNT(*) FROM audit_events');

        // P1 has no bytes in the vault.
        $res = $this->doctorAction(DownloadPatientDocumentAction::class, $this->userA, ['id' => $this->apNext, 'docId' => $this->P1], method: 'GET');
        $this->assertSame(404, $res['status']);
        $this->assertSame('File not found', $res['body']['message']);
        $this->assertNotSame('not_shared', $res['body']['errors']['code'] ?? null);
        $this->assertSame($audits, $this->countRows('SELECT COUNT(*) FROM audit_events'), 'no document.viewed row');
        $this->assertSame(0, $this->countRows("SELECT COUNT(*) FROM document_access_log WHERE event = 'viewed'"), 'the Activity never claims an open');
        $this->assertSame(0, $this->countRows('SELECT COALESCE(SUM(access_count), 0) FROM document_access_grants'));
        $this->assertSame(0, $this->countRows('SELECT COUNT(*) FROM document_access_grants WHERE last_accessed_at IS NOT NULL'));
    }

    public function testWhenTheViewCannotBeRecordedNothingIsStreamed(): void
    {
        $this->share($this->P, ['specialist_ids' => [$this->A]]);
        $this->storeBytes($this->P1);
        $this->conn()->executeStatement('ALTER TABLE audit_events RENAME TO audit_events_off');
        try {
            $res = $this->doctorAction(DownloadPatientDocumentAction::class, $this->userA, ['id' => $this->apNext, 'docId' => $this->P1], method: 'GET');
        } finally {
            $this->conn()->executeStatement('ALTER TABLE audit_events_off RENAME TO audit_events');
        }
        $this->assertSame(503, $res['status']);
        $this->assertSame('view_unavailable', $res['body']['errors']['code']);
        $this->assertSame('application/json', $res['response']->getHeaderLine('Content-Type'));
        $this->assertSame(0, $this->countRows("SELECT COUNT(*) FROM document_access_log WHERE event = 'viewed'"));
        $this->assertSame(0, $this->countRows('SELECT COALESCE(SUM(access_count), 0) FROM document_access_grants'));
    }

    public function testAPassivePollIsNeverAuditedAndAnActiveOpenIsAuditedOncePerWindow(): void
    {
        $this->share($this->P, ['specialist_ids' => [$this->A]]);
        $passive = $this->doctorAction(DoctorDocumentAccessAction::class, $this->userA, ['id' => $this->apNext], headers: ['X-SD-Passive' => '1'], method: 'GET');
        $this->assertSame(200, $passive['status']);
        $this->assertSame('no-store', $passive['response']->getHeaderLine('Cache-Control'));
        $this->assertSame(0, $this->countRows("SELECT COUNT(*) FROM audit_events WHERE action = 'document.list_viewed'"));

        $this->doctorAction(DoctorDocumentAccessAction::class, $this->userA, ['id' => $this->apNext], method: 'GET');
        $active = $this->doctorAction(DoctorDocumentAccessAction::class, $this->userA, ['id' => $this->apNext], method: 'GET');
        $this->assertSame(1, $this->countRows("SELECT COUNT(*) FROM audit_events WHERE action = 'document.list_viewed'"), 'coalesced for 15 minutes');

        $data = $active['body']['data'];
        $this->assertSame('active', $data['access']['state']);
        $this->assertSame('all', $data['access']['scope']);
        $this->assertTrue($data['access']['indefinite']);
        $this->assertCount(3, $data['documents']);
        $this->assertArrayNotHasKey('shared_with', $data['documents'][0]);
        $this->assertSame('folder', $data['documents'][0]['via']);
        $this->assertSame('has_full_access', $data['request']['blocked_reason']);
    }

    public function testTheLedgerNeverShowsAnotherPatientsTitle(): void
    {
        (new DocumentAccessLogRepository($this->em()))->append([
            'patient_id' => $this->P, 'specialist_id' => $this->A, 'document_id' => $this->Q1, 'event' => 'viewed', 'actor_role' => 'doctor',
        ], $this->now);
        $this->share($this->P, ['specialist_ids' => [$this->A], 'scope' => 'selected', 'document_ids' => [$this->P1]]);
        $this->storeBytes($this->P1);
        $this->assertSame(200, $this->doctorAction(DownloadPatientDocumentAction::class, $this->userA, ['id' => $this->apNext, 'docId' => $this->P1], method: 'GET')['status']);

        $res = $this->patientAction(ListDocumentAccessHistoryAction::class, $this->P, [], [], ['per_page' => '50'], 'GET');
        $this->assertSame(200, $res['status']);
        $titles = [];
        foreach ($res['body']['data'] as $event) {
            if ($event['document'] !== null) {
                $titles[$event['document']['id']] = $event['document']['title'];
            }
        }
        $this->assertNull($titles[$this->Q1], "never another patient's title");
        $this->assertSame('HIV test result', $titles[$this->P1], 'the patient sees their own titles');
        $this->assertSame(3, $res['body']['meta']['total']);
    }

    public function testThePatientSeesWhoCanSeeWhatOnTheirListTheirDoctorsAndTheConsultation(): void
    {
        $this->share($this->P, ['specialist_ids' => [$this->A], 'scope' => 'selected', 'document_ids' => [$this->P1], 'duration' => '7d']);
        $this->suspend($this->G, $this->now->modify('-1 day'));
        (new \App\Domain\Repository\DocumentAccessGrantRepository($this->em()))->insertGrant([
            'patient_id' => $this->P, 'specialist_id' => $this->G, 'scope' => 'all', 'source' => 'share', 'surface' => 'manage_sharing', 'duration' => 'indefinite', 'expires_at' => null,
        ], $this->now->modify('-2 days'));

        $list = $this->patientAction(ListMyDocumentsAction::class, $this->P, [], [], [], 'GET');
        $this->assertSame(200, $list['status']);
        $byId = array_column($list['body']['data'], 'shared_with', 'id');
        $this->assertCount(2, $byId[$this->P1], 'A individually, G through the folder');
        $g = array_values(array_filter($byId[$this->P1], fn (array $w): bool => $w['specialist_id'] === $this->G))[0];
        $this->assertTrue($g['paused']);
        $this->assertSame('folder', $g['via']);
        $this->assertCount(1, $byId[$this->P2]);

        $doctors = $this->patientAction(ListSharingDoctorsAction::class, $this->P, [], [], [], 'GET');
        $this->assertSame(200, $doctors['status']);
        $ids = array_map(static fn (array $d): string => $d['specialist']['id'], $doctors['body']['data']);
        $this->assertEqualsCanonicalizing([$this->A, $this->B, $this->G], $ids, 'every booked doctor, never C');
        foreach ($doctors['body']['data'] as $d) {
            if ($d['specialist']['id'] === $this->G) {
                $this->assertSame('paused', $d['access']['state']);
                $this->assertFalse($d['can_share']);
                $this->assertSame('doctor_unavailable', $d['unavailable_reason']);
                $this->assertTrue($d['access']['folder_indefinite']);
            }
            if ($d['specialist']['id'] === $this->A) {
                $this->assertSame('active', $d['access']['state']);
                $this->assertSame('selected', $d['access']['scope']);
                $this->assertSame(1, $d['access']['document_count']);
                $this->assertNotNull($d['next_appointment']);
                $this->assertNull($d['access']['folder_until_label_at']);
            }
        }

        $appt = $this->patientAction(GetAppointmentDocumentAccessAction::class, $this->P, [], ['id' => $this->apNext], [], 'GET');
        $this->assertSame(200, $appt['status']);
        $this->assertSame([$this->P1], array_column($appt['body']['data']['visible_documents'], 'id'));
        $this->assertNotNull($appt['body']['data']['appointment']['after_options']['after_24h']);
    }
}
