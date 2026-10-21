<?php

declare(strict_types=1);

namespace App\Tests\Integration\DocumentSharing;

use App\Action\Appointment\GetMyAppointmentAction;
use App\Action\Doctor\DoctorDocumentAccessAction;
use App\Action\Doctor\RequestDocumentAccessAction;
use App\Action\DocumentSharing\GetAppointmentDocumentAccessAction;
use App\Action\DocumentSharing\GetDocumentAccessAction;
use App\Action\DocumentSharing\ListAccessRequestsAction;
use App\Action\DocumentSharing\ListDocumentGrantsAction;
use App\Action\DocumentSharing\ListSharingDoctorsAction;
use App\Domain\Document\DocumentSharingRules as Rules;
use App\Tests\Unit\DtoShapeTest as Shape;

/**
 * Whole responses, through the real actions against Postgres, carry exactly
 * the keys of the TypeScript contract (spec §8.2) — the views half of the DTO
 * shape check (DtoShapeTest covers the presenter's pieces offline).
 */
final class ContractShapeTest extends DocShareTestCase
{
    private const SHARING_DOCTOR      = ['specialist', 'can_share', 'unavailable_reason', 'last_appointment_at', 'next_appointment', 'access', 'pending_request', 'requests_blocked'];
    private const APPOINTMENT_ACCESS  = ['specialist', 'appointment', 'can_share', 'unavailable_reason', 'access', 'visible_documents', 'unshared_attachments', 'pending_request'];
    private const DOCUMENT_ACCESS     = ['document_id', 'doctors', 'hidden_from', 'eligible_doctors', 'history'];
    private const DOCTOR_ACCESS       = ['access', 'documents', 'request', 'server_time'];
    private const DOCTOR_ACCESS_STATE = Shape::DOCTOR_ACCESS_STATE;
    private const DOCTOR_REQUEST_PART = ['can_request', 'kind', 'blocked_reason', 'available_at', 'pending', 'last'];

    public function testPatientResponses(): void
    {
        $this->share($this->P, ['specialist_ids' => [$this->A], 'scope' => 'selected', 'document_ids' => [$this->P1], 'duration' => 'after_24h', 'appointment_id' => $this->apNext]);
        $this->share($this->P, ['specialist_ids' => [$this->G]]);
        [$svc, $em] = $this->request();
        $svc->removeDocumentAccess($this->patient($em, $this->P), $this->P2, $this->G, $this->now);
        $this->conn()->executeStatement('UPDATE medical_documents SET appointment_id = ? WHERE id = ?', [$this->apNext, $this->P3]);
        $this->doctorAction(RequestDocumentAccessAction::class, $this->userA, ['id' => $this->apNext]);

        $doctors = $this->patientAction(ListSharingDoctorsAction::class, $this->P, method: 'GET')['body']['data'];
        foreach ($doctors as $d) {
            $this->assertKeys(self::SHARING_DOCTOR, $d);
            $this->assertKeys(Shape::DOCTOR_REF, $d['specialist']);
            $this->assertKeys(Shape::ACCESS_SUMMARY, $d['access']);
            if ($d['next_appointment'] !== null) {
                $this->assertKeys(Shape::APPOINTMENT_REF, $d['next_appointment']);
            }
            if ($d['pending_request'] !== null) {
                $this->assertKeys(Shape::REQUEST, $d['pending_request']);
                $this->assertKeys(Shape::SUGGESTION, $d['pending_request']['suggestion']);
                $this->assertSame([$this->P3], $d['pending_request']['suggestion']['document_ids'], 'the files attached for that consultation');
            }
        }
        $g = array_values(array_filter($doctors, fn (array $d): bool => $d['specialist']['id'] === $this->G))[0];
        $this->assertSame([$this->P2], $g['access']['hidden_document_ids']);

        foreach ($this->patientAction(ListDocumentGrantsAction::class, $this->P, method: 'GET')['body']['data'] as $grant) {
            $this->assertKeys(Shape::GRANT, $grant);
            if ($grant['appointment'] !== null) {
                $this->assertKeys(Shape::APPOINTMENT_REF, $grant['appointment']);
            }
        }
        foreach ($this->patientAction(ListAccessRequestsAction::class, $this->P, method: 'GET')['body']['data'] as $request) {
            $this->assertKeys(Shape::REQUEST, $request);
        }

        $detail = $this->patientAction(GetDocumentAccessAction::class, $this->P, [], ['id' => $this->P2], method: 'GET')['body']['data'];
        $this->assertKeys(self::DOCUMENT_ACCESS, $detail);
        $this->assertKeys(['specialist', 'folder_until_label_at'], $detail['hidden_from'][0]);
        foreach ($detail['eligible_doctors'] as $ref) {
            $this->assertKeys(Shape::DOCTOR_REF, $ref);
        }
        foreach ($detail['history'] as $event) {
            $this->assertKeys(Shape::EVENT, $event);
        }
        $p1 = $this->patientAction(GetDocumentAccessAction::class, $this->P, [], ['id' => $this->P1], method: 'GET')['body']['data'];
        foreach ($p1['doctors'] as $who) {
            $this->assertKeys([...Shape::SHARED_WITH, 'specialist', 'grant_ids', 'last_viewed_at'], $who);
        }

        $appt = $this->patientAction(GetAppointmentDocumentAccessAction::class, $this->P, [], ['id' => $this->apNext], method: 'GET')['body']['data'];
        $this->assertKeys(self::APPOINTMENT_ACCESS, $appt);
        $this->assertKeys([...Shape::MEDICAL_DOCUMENT, 'via', 'until', 'until_label_at', 'indefinite'], $appt['visible_documents'][0]);
        $this->assertKeys(Shape::MEDICAL_DOCUMENT, $appt['unshared_attachments'][0]);
        $this->assertSame([$this->P3], array_column($appt['unshared_attachments'], 'id'));
        $this->assertKeys(Shape::REQUEST, $appt['pending_request']);

        $mine = $this->patientAction(GetMyAppointmentAction::class, $this->P, [], ['id' => $this->apNext], method: 'GET')['body']['data'];
        $this->assertKeys(Shape::REQUEST, $mine['pending_document_request']);
        $this->assertArrayHasKey('document_url', $mine);
    }

    public function testWriteResults(): void
    {
        $result = $this->share($this->P, ['specialist_ids' => [$this->A, $this->G], 'scope' => 'selected', 'document_ids' => [$this->P1]]);
        $this->assertKeys(['grants', 'outcomes', 'approved_request_ids', 'replayed'], $result);
        $this->assertKeys(['specialist_id', 'grant_id', 'outcome'], $result['outcomes'][0]);

        [$svc, $em] = $this->request();
        $revoked = $svc->revokeAll($this->patient($em, $this->P), $this->now);
        $this->assertKeys(['revoked', 'revoke_batch_id', 'restorable_until'], $revoked);
        $this->assertNotNull($revoked['revoked'][0]['restorable_until']);

        [$svc, $em] = $this->request();
        $restored = $svc->restore($this->patient($em, $this->P), $revoked['revoked'][0]['id'], $this->now);
        $this->assertKeys(['restored', 'skipped_grant_ids'], $restored);
        $this->assertKeys(Shape::GRANT, $restored['restored'][0]);
    }

    public function testDoctorResponse(): void
    {
        $this->share($this->P, ['specialist_ids' => [$this->A], 'duration' => '24h']);
        $this->doctorAction(RequestDocumentAccessAction::class, $this->userA, ['id' => $this->apNext]);
        $res  = $this->doctorAction(DoctorDocumentAccessAction::class, $this->userA, ['id' => $this->apNext], method: 'GET');
        $data = $res['body']['data'];

        $this->assertKeys(self::DOCTOR_ACCESS, $data);
        $this->assertKeys(self::DOCTOR_ACCESS_STATE, $data['access']);
        $this->assertKeys(self::DOCTOR_REQUEST_PART, $data['request']);
        $this->assertKeys(Shape::DOCTOR_DOCUMENT, $data['documents'][0]);
        $this->assertKeys(Shape::DOCTOR_REQUEST, $data['request']['pending']);
        $this->assertTrue($data['access']['ends_soon']);
        $this->assertSame('request_pending', $data['request']['blocked_reason']);
        $this->assertSame('extend', $data['request']['pending']['kind']);
        $this->assertFalse($data['access']['folder_indefinite']);
        $this->assertSame($data['access']['until_label_at'], $data['access']['folder_until_label_at'], 'only the folder share: both ends agree');
    }

    /**
     * A folder share with an end plus one document shared with no end: the
     * overall end is "no end date" (NULL wins), but the whole folder — and so
     * every new upload — stops at the folder share's own end. The doctor's DTO
     * carries both, like the patient's summary.
     */
    public function testDoctorFolderEndIsTheFolderSharesOwn(): void
    {
        $this->share($this->P, ['specialist_ids' => [$this->A], 'duration' => '7d']);
        $this->share($this->P, ['specialist_ids' => [$this->A], 'scope' => 'selected', 'document_ids' => [$this->P1], 'duration' => 'indefinite']);

        $access = $this->doctorAction(DoctorDocumentAccessAction::class, $this->userA, ['id' => $this->apNext], method: 'GET')['body']['data']['access'];
        $this->assertKeys(self::DOCTOR_ACCESS_STATE, $access);
        $this->assertSame('all', $access['scope']);
        $this->assertTrue($access['indefinite']);
        $this->assertNull($access['until_label_at']);
        $this->assertFalse($access['folder_indefinite']);
        $this->assertSame(Rules::iso($this->now->modify('+7 days')), $access['folder_until_label_at']);
        $this->assertFalse($access['ends_soon']);

        // The patient's own summary of that doctor agrees.
        $doctors = $this->patientAction(ListSharingDoctorsAction::class, $this->P, method: 'GET')['body']['data'];
        $a       = array_values(array_filter($doctors, fn (array $d): bool => $d['specialist']['id'] === $this->A))[0];
        $this->assertSame($access['folder_until_label_at'], $a['access']['folder_until_label_at']);
        $this->assertSame($access['folder_indefinite'], $a['access']['folder_indefinite']);
        $this->assertSame($access['indefinite'], $a['access']['indefinite']);
    }

    public function testDoctorFolderShareWithNoEnd(): void
    {
        $this->share($this->P, ['specialist_ids' => [$this->A]]);

        $access = $this->doctorAction(DoctorDocumentAccessAction::class, $this->userA, ['id' => $this->apNext], method: 'GET')['body']['data']['access'];
        $this->assertTrue($access['folder_indefinite']);
        $this->assertNull($access['folder_until_label_at']);
        $this->assertTrue($access['indefinite']);
    }

    public function testDoctorWithoutFolderShareHasNoFolderEnd(): void
    {
        $this->share($this->P, ['specialist_ids' => [$this->A], 'scope' => 'selected', 'document_ids' => [$this->P1], 'duration' => '7d']);

        $access = $this->doctorAction(DoctorDocumentAccessAction::class, $this->userA, ['id' => $this->apNext], method: 'GET')['body']['data']['access'];
        $this->assertSame('selected', $access['scope']);
        $this->assertNull($access['folder_until_label_at']);
        $this->assertFalse($access['folder_indefinite']);
        $this->assertNotNull($access['until_label_at']);
    }

    /** @param list<string> $expected @param array<string,mixed> $actual */
    private function assertKeys(array $expected, array $actual): void
    {
        $keys = array_keys($actual);
        sort($keys);
        sort($expected);
        $this->assertSame($expected, $keys);
    }
}
