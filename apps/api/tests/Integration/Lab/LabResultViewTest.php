<?php

declare(strict_types=1);

namespace App\Tests\Integration\Lab;

use App\Action\LabRequest\Doctor\RecordLabResultPrintAction;
use App\Action\LabRequest\Doctor\ViewLabResultAction;

/**
 * A doctor opens a lab result only in the view-only viewer (lab spec §2.2,
 * mirroring ViewOnlyTest): the viewer header, the policy, the types it can
 * show, the view recorded with its reference (and the request) before a byte
 * is streamed, and prints citing a real view.
 */
final class LabResultViewTest extends LabTestCase
{
    private const VIEWER = ['X-SD-Viewer' => '1'];

    /** @return array{0:string, 1:string} [request id, result id] */
    private function labResult(?\Slim\Psr7\UploadedFile $file = null, string $share = '1'): array
    {
        $id = $this->booked();
        $up = $this->upload($id, $file, ['share' => $share]);
        $this->assertSame(201, $up['status'], json_encode($up['body']));

        return [$id, $up['body']['data']['result']['id']];
    }

    /** @return array{0:int, 1:int} audit rows, ledger rows */
    private function recorded(): array
    {
        return [
            $this->countRows("SELECT COUNT(*) FROM audit_events WHERE action IN ('document.viewed', 'document.printed')"),
            $this->countRows("SELECT COUNT(*) FROM document_access_log WHERE event IN ('viewed', 'printed')"),
        ];
    }

    public function testAnOldTabWithoutTheViewerHeaderMustReload(): void
    {
        [$id, $resultId] = $this->labResult();
        $res = $this->doctorAction(ViewLabResultAction::class, $this->userA, ['labId' => $id, 'resultId' => $resultId], [], [], 'GET');
        $this->assertSame(409, $res['status']);
        $this->assertSame('update_required', $res['body']['errors']['code']);
        $this->assertSame([0, 0], $this->recorded());
    }

    public function testOnlyTheRequestingDoctorAndOnlyWhatIsShared(): void
    {
        [$id, $resultId] = $this->labResult(null, '0');
        $this->assertSame(404, $this->doctorAction(ViewLabResultAction::class, $this->userB, ['labId' => $id, 'resultId' => $resultId], [], self::VIEWER, 'GET')['status']);
        $res = $this->doctorAction(ViewLabResultAction::class, $this->userA, ['labId' => $id, 'resultId' => $resultId], [], self::VIEWER, 'GET');
        $this->assertSame(404, $res['status']);
        $this->assertSame('not_shared', $res['body']['errors']['code']);

        [$docxId, $docxResult] = $this->labResult($this->docx());
        $docx = $this->doctorAction(ViewLabResultAction::class, $this->userA, ['labId' => $docxId, 'resultId' => $docxResult], [], self::VIEWER, 'GET');
        $this->assertSame(415, $docx['status']);
        $this->assertSame('not_viewable', $docx['body']['errors']['code']);
        $this->assertSame([0, 0], $this->recorded());
    }

    public function testAViewIsRecordedWithItsReferenceAndTheRequest(): void
    {
        [$id, $resultId] = $this->labResult();
        $res = $this->doctorAction(ViewLabResultAction::class, $this->userA, ['labId' => $id, 'resultId' => $resultId], [], self::VIEWER, 'GET');
        $this->assertSame(200, $res['status']);
        $r = $res['response'];
        $this->assertSame('application/pdf', $r->getHeaderLine('Content-Type'));
        $this->assertSame('inline', $r->getHeaderLine('Content-Disposition'));
        $this->assertSame('private, no-store, max-age=0', $r->getHeaderLine('Cache-Control'));
        $this->assertSame("default-src 'none'; sandbox", $r->getHeaderLine('Content-Security-Policy'));
        $ref    = $r->getHeaderLine('X-SD-View-Ref');
        $ledger = (string) $this->conn()->fetchOne("SELECT CAST(id AS TEXT) FROM document_access_log WHERE event = 'viewed'");
        $this->assertSame('VM-' . strtoupper(substr(str_replace('-', '', $ledger), 0, 8)), $ref);
        $audit = json_decode((string) $this->conn()->fetchOne("SELECT CAST(metadata AS TEXT) FROM audit_events WHERE action = 'document.viewed'"), true);
        $this->assertSame($ref, $audit['view_ref']);
        $this->assertSame($id, $audit['lab_request_id']);
        $this->assertSame([1, 1], $this->recorded());

        $kept = $this->doctorAction(RecordLabResultPrintAction::class, $this->userA, ['labId' => $id, 'resultId' => $resultId], ['view_ref' => $ref]);
        $this->assertSame(200, $kept['status']);
        $this->assertSame($ref, json_decode((string) $this->conn()->fetchOne("SELECT CAST(metadata AS TEXT) FROM audit_events WHERE action = 'document.printed'"), true)['view_ref']);
        $this->doctorAction(RecordLabResultPrintAction::class, $this->userA, ['labId' => $id, 'resultId' => $resultId], ['view_ref' => 'VM-00000000']);
        $refs = $this->conn()->fetchFirstColumn("SELECT metadata->>'view_ref' FROM audit_events WHERE action = 'document.printed' ORDER BY created_at, id");
        $this->assertContains(null, $refs, 'a foreign reference is stored as null');
        $this->assertSame(2, $this->countRows("SELECT COUNT(*) FROM document_access_log WHERE event = 'printed'"));
        $this->assertSame(404, $this->doctorAction(RecordLabResultPrintAction::class, $this->userB, ['labId' => $id, 'resultId' => $resultId], [])['status']);
    }
}
