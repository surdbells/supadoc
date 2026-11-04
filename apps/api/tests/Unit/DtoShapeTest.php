<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Domain\Document\DocumentSharingRules as Rules;
use App\Domain\Entity\Appointment;
use App\Domain\Entity\MedicalDocument;
use App\Domain\Entity\Patient;
use App\Domain\Entity\Specialist;
use App\Domain\Enum\AppointmentStatus;
use App\Domain\Enum\ConsultationType;
use App\Infrastructure\Document\DocumentSharingPresenter as Presenter;
use App\Infrastructure\Document\VisibleDocument;
use DateTimeImmutable;
use PHPUnit\Framework\TestCase;

/**
 * The PHP side emits EXACTLY the keys of the TypeScript contract
 * (libs/shared/models/src/lib/document-sharing.ts, spec §8.2) — and the doctor
 * allowlist never carries a patient-side extra (spec §3.6). The views that
 * assemble whole responses are checked against a database in
 * ContractShapeTest (integration).
 */
final class DtoShapeTest extends TestCase
{
    public const MEDICAL_DOCUMENT = ['id', 'patient_id', 'uploader_role', 'uploader_name', 'appointment_id', 'document_type', 'custom_type', 'type_label', 'title', 'extension', 'mime_type', 'size_bytes', 'size_label', 'created_at'];
    public const DOCTOR_REF       = ['id', 'name', 'specialty', 'photo_url'];
    public const APPOINTMENT_REF  = ['id', 'scheduled_at', 'ends_at', 'after_options'];
    public const AFTER_OPTIONS    = ['after_24h', 'after_7d', 'after_30d'];
    public const SHARED_WITH      = ['specialist_id', 'name', 'via', 'until', 'until_label_at', 'indefinite', 'paused'];
    public const ACCESS_SUMMARY   = ['state', 'scope', 'document_count', 'until', 'until_label_at', 'indefinite', 'folder_until_label_at', 'folder_indefinite', 'next_change_at', 'last_viewed_at', 'active_grant_ids', 'hidden_count', 'hidden_document_ids'];
    public const GRANT            = ['id', 'specialist', 'scope', 'status', 'source', 'surface', 'duration', 'starts_at', 'expires_at', 'until_label_at', 'ended_at', 'end_reason', 'ended_by', 'document_ids', 'document_count', 'appointment', 'request_id', 'revoke_batch_id', 'restorable_until', 'last_accessed_at', 'access_count', 'created_at'];
    public const SUGGESTION       = ['scope', 'document_ids', 'duration', 'appointment_id'];
    public const REQUEST          = ['id', 'specialist', 'appointment', 'kind', 'status', 'message', 'created_at', 'expires_at', 'decided_at', 'grant_id', 'suggestion'];
    public const DOCTOR_REQUEST   = ['id', 'kind', 'status', 'message', 'appointment_id', 'created_at', 'expires_at', 'decided_at'];
    public const EVENT            = ['id', 'event', 'actor', 'specialist', 'document', 'grant_id', 'request_id', 'details', 'created_at'];
    public const DOCTOR_DOCUMENT  = [...self::MEDICAL_DOCUMENT, 'via', 'shared_until', 'shared_until_label_at', 'shared_indefinitely', 'shared_at', 'viewable'];
    /** DoctorDocumentAccessDto.access (DocumentAccessPolicy::doctorSummary needs a database: checked in ContractShapeTest). */
    public const DOCTOR_ACCESS_STATE = ['state', 'scope', 'document_count', 'until', 'until_label_at', 'indefinite', 'folder_until_label_at', 'folder_indefinite', 'next_change_at', 'ends_soon', 'had_access_before'];

    public function testTheDoctorAllowlistIsExactAndHidesPatientSideFields(): void
    {
        $doc = $this->document('patient', 'appt-mine');
        $out = $doc->toDoctorArray('s-1', ['APPT-MINE']);
        $this->assertKeys(self::MEDICAL_DOCUMENT, $out);
        $this->assertSame('Pat Patient', $out['uploader_name']);
        $this->assertSame('appt-mine', $out['appointment_id'], 'their own consultation');

        $foreign = $this->document('patient', 'appt-other')->toDoctorArray('s-1', ['appt-mine']);
        $this->assertNull($foreign['appointment_id'], "another doctor's consultation is never named");
        $staff = $this->document('staff', null)->toDoctorArray('s-1', []);
        $this->assertNull($staff['uploader_name'], 'only the patient\'s own uploads carry a name');

        $shared = Presenter::doctorSharedDocument($this->visible($doc), 's-1', ['appt-mine']);
        $this->assertKeys(self::DOCTOR_DOCUMENT, $shared);
        $this->assertArrayNotHasKey('shared_with', $shared);
    }

    public function testRefsSummaryAndSharedWith(): void
    {
        $s = $this->doctor('s-1');
        $this->assertKeys(self::DOCTOR_REF, Presenter::doctorRef($s));
        $ref = Presenter::appointmentRef($this->appointment($s), 'p-1', 's-1', new DateTimeImmutable());
        $this->assertKeys(self::APPOINTMENT_REF, $ref);
        $this->assertKeys(self::AFTER_OPTIONS, $ref['after_options']);

        $this->assertKeys(self::SHARED_WITH, Presenter::sharedWith($this->visible($this->document('patient', null)), 'S-1', 'Dr. Test', false));
        $summary = Presenter::accessSummary([$this->grantRow(['scope' => 'all', 'expires_at' => null])], 3, true, ['d-1']);
        $this->assertKeys(self::ACCESS_SUMMARY, $summary);
        $this->assertTrue($summary['folder_indefinite']);
        $this->assertNull($summary['folder_until_label_at']);
        $none = Presenter::accessSummary([], 0, true, []);
        $this->assertSame(['none', null, 0, false], [$none['state'], $none['scope'], $none['document_count'], $none['folder_indefinite']]);
        $this->assertSame('paused', Presenter::accessSummary([$this->grantRow()], 1, false, [])['state']);
    }

    public function testGrantRequestEventShapes(): void
    {
        // Every instant is explicit (UTC) and the rows hold it as a timestamp column
        // would (self::stored()), so this reads the same on any process zone.
        $now   = new DateTimeImmutable('2026-10-21T10:00:00Z');
        $grant = Presenter::grant($this->grantRow(), Presenter::doctorRef($this->doctor('s-1')), null, ['d-1'], 1, true, true, $now);
        $this->assertKeys(self::GRANT, $grant);
        $this->assertSame('active', $grant['status']);

        $revoked = Presenter::grant($this->grantRow([
            'status' => 'revoked', 'end_reason' => 'revoked', 'ended_by' => 'patient', 'ended_at' => self::stored('2026-10-21T09:55:00Z'), 'revoke_batch_id' => 'b-1',
        ]), Presenter::doctorRef($this->doctor('s-1')), null, [], 0, false, true, $now);
        $this->assertSame('2026-10-21T10:05:00+00:00', (new DateTimeImmutable((string) $revoked['restorable_until']))->setTimezone(new \DateTimeZone('UTC'))->format(DATE_ATOM), 'restorable for ten minutes after the revoke');
        $past = Presenter::grant($this->grantRow(['expires_at' => self::stored('2026-10-21T09:00:00Z')]), Presenter::doctorRef($this->doctor('s-1')), null, [], 0, false, true, $now);
        $this->assertSame(['expired', 'expired', 'system'], [$past['status'], $past['end_reason'], $past['ended_by']], 'past its end before the sweeper recorded it');

        $suggestion = Presenter::suggestion('access', null, []);
        $this->assertKeys(self::SUGGESTION, $suggestion);
        $this->assertNull($suggestion['scope'], 'nothing sensible: the patient chooses');
        $this->assertSame('all', Presenter::suggestion('extend', null, [])['scope']);
        $this->assertSame(['selected', ['d-1']], array_values(array_slice(Presenter::suggestion('access', null, ['d-1']), 0, 2)));

        $requestRow = ['id' => 'r-1', 'kind' => 'access', 'status' => 'pending', 'message' => null, 'appointment_id' => 'a-1', 'created_at' => self::stored('2026-10-20T10:00:00Z'), 'expires_at' => self::stored('2026-10-21T09:00:00Z'), 'decided_at' => null];
        $this->assertKeys(self::REQUEST, Presenter::request($requestRow, Presenter::doctorRef($this->doctor('s-1')), null, null, $suggestion, $now));
        $doctorRequest = Presenter::doctorRequest($requestRow, $now);
        $this->assertKeys(self::DOCTOR_REQUEST, $doctorRequest);
        $this->assertSame('expired', $doctorRequest['status'], 'a pending request past its close reads as expired');

        $event = Presenter::event(['id' => 'l-1', 'event' => 'shared', 'actor_role' => 'patient', 'document_id' => 'd-1', 'title' => null, 'grant_id' => 'g-1', 'request_id' => null,
            'details' => json_encode(['scope' => 'all', 'duration' => 'until', 'expires_at' => '2026-10-31T00:00:00+00:00', 'surface' => 'call', 'consent_version' => 'x']), 'created_at' => self::stored('2026-10-21T10:00:00Z')], null);
        $this->assertKeys(self::EVENT, $event);
        $this->assertSame(['scope', 'duration', 'expires_at', 'until_label_at'], array_keys($event['details']), 'only the contract detail keys');
        $this->assertSame(['id' => 'd-1', 'title' => null], $event['document']);
    }

    public function testUploadedAndPatientVisibleDocumentsExtendTheDocument(): void
    {
        $doc = $this->document('patient', null);
        $this->assertKeys([...self::MEDICAL_DOCUMENT, 'shared_with', 'share_outcome', 'share_ended_for'], Presenter::uploaded($doc, [], 'private', []));
        $this->assertKeys([...self::MEDICAL_DOCUMENT, 'via', 'until', 'until_label_at', 'indefinite'], Presenter::patientVisibleDocument($this->visible($doc)));
    }

    // ----- Helpers -----

    /** @param list<string> $expected @param array<string,mixed> $actual */
    // ----- Doctor applications (libs/shared/models/src/lib/doctor-application.ts) -----
    public const APP_DOCUMENT       = ['id', 'slot', 'slot_label', 'label', 'original_name', 'mime', 'size_bytes', 'state', 'uploaded_during', 'uploaded_at'];
    public const APP_SUBMITTED      = ['id', 'reference', 'status', 'submitted_at', 'email', 'phone'];
    public const APP_ROW            = ['id', 'reference', 'status', 'status_label', 'full_name', 'email', 'specialty', 'licence_route', 'licence_label', 'submitted_at', 'awaiting_staff', 'interview_starts_at', 'last_activity_at'];
    public const APP_INTERVIEW      = ['starts_at', 'starts_at_label', 'duration_minutes', 'meeting_url', 'meeting_host', 'note', 'applicant_time_zone', 'applicant_label'];
    public const APP_INFO_REQUEST   = ['id', 'message', 'items', 'requested_at', 'responded_at', 'response_note'];
    public const APP_EVENT          = ['id', 'kind', 'label', 'from_status', 'to_status', 'actor_type', 'actor_name', 'applicant_visible', 'public_message', 'channel', 'created_at'];
    public const APP_NOTE           = ['id', 'author_name', 'body', 'created_at'];
    public const APP_SECTIONS       = ['personal', 'professional', 'licence', 'qualifications', 'indemnity', 'consent'];
    public const APP_DRAFT          = ['id', 'status', 'licence_route', 'sections', 'documents', 'steps', 'next_step', 'ready_to_submit', 'email_verified', 'expires_at', 'last_saved_at'];
    public const APP_STATUS         = ['id', 'reference', 'status', 'status_label', 'full_name', 'licence_route', 'submitted_at', 'timeline', 'interview', 'info_request', 'rejection_reason', 'can_withdraw', 'doctor_portal_url', 'email_masked'];
    public const APP_APPLICANT_APP  = ['id', 'reference', 'status', 'licence_route', 'sections', 'documents', 'info_request'];
    public const APP_DETAIL_EXTRA   = ['phone', 'email_verified_at', 'sections', 'documents', 'info_requests', 'interview', 'rejection_reason', 'withdraw_reason', 'withdraw_reason_label', 'review_started_at', 'review_started_by_name', 'decided_at', 'decided_by_name', 'consent', 'specialist', 'actions', 'approval', 'events', 'notes_count'];
    public const APP_APPROVAL       = ['ready', 'problems', 'documents', 'login', 'specialty_on_list', 'register_name'];
    public const APP_PREFILL        = ['document_id', 'slot', 'slot_label', 'original_name', 'credential_type', 'needs_number', 'needs_issue_date', 'needs_expiry', 'prefill', 'reference_hint', 'expiry_hint'];
    public const APP_CONFIG         = ['consent_version', 'max_upload_bytes', 'accepted_mime', 'doctor_portal_url', 'support_email', 'draft_ttl_days', 'good_standing_max_age_months', 'sms_enabled', 'legal_terms_url', 'legal_privacy_url', 'patient_site_url'];

    /** The key lists above ARE the TypeScript contract's (parsed from doctor-application.ts). */
    public function testTheApplicationKeyListsMatchTheTypeScriptContract(): void
    {
        $ts = (string) file_get_contents(__DIR__ . '/../../../../libs/shared/models/src/lib/doctor-application.ts');
        $keys = static function (string $name) use ($ts): array {
            // \R: the checkout may carry CRLF line endings (core.autocrlf on Windows).
            if (preg_match('/export interface ' . $name . '\b[^{]*\{\R(.*?)\R\}/s', $ts, $m) !== 1) {
                throw new \RuntimeException('interface not found: ' . $name);
            }
            preg_match_all('/^  ([a-z_0-9]+)\??:/m', $m[1], $k);

            return $k[1];
        };
        $same = function (array $expected, array $actual, string $name): void {
            sort($expected);
            sort($actual);
            $this->assertSame($expected, $actual, $name);
        };
        $same([...self::APP_DOCUMENT, 'credential_id', 'sha256'], $keys('ApplicationDocumentDto'), 'ApplicationDocumentDto');
        $same(self::APP_SUBMITTED, $keys('SubmittedApplicationDto'), 'SubmittedApplicationDto');
        $same(self::APP_ROW, $keys('DoctorApplicationRowDto'), 'DoctorApplicationRowDto');
        $same(self::APP_INTERVIEW, $keys('ApplicationInterviewDto'), 'ApplicationInterviewDto');
        $same([...self::APP_INFO_REQUEST, 'requested_by_name', 'closed_at', 'close_reason', 'updated_sections'], $keys('ApplicationInfoRequestDto'), 'ApplicationInfoRequestDto');
        $same(self::APP_EVENT, $keys('DoctorApplicationEventDto'), 'DoctorApplicationEventDto');
        $same(self::APP_NOTE, $keys('DoctorApplicationNoteDto'), 'DoctorApplicationNoteDto');
        $same(self::APP_SECTIONS, $keys('ApplicationSections'), 'ApplicationSections');
        $same(self::APP_DRAFT, $keys('ApplicationDraftDto'), 'ApplicationDraftDto');
        $same(self::APP_STATUS, $keys('ApplicationStatusDto'), 'ApplicationStatusDto');
        $same(self::APP_APPLICANT_APP, $keys('ApplicantApplicationDto'), 'ApplicantApplicationDto');
        $same(self::APP_DETAIL_EXTRA, $keys('DoctorApplicationDetailDto'), 'DoctorApplicationDetailDto');
        $same(self::APP_APPROVAL, $keys('ApprovalPreviewDto'), 'ApprovalPreviewDto');
        $same(self::APP_PREFILL, $keys('ApprovalDocumentPrefillDto'), 'ApprovalDocumentPrefillDto');
        $same(self::APP_CONFIG, $keys('ApplicationConfigDto'), 'ApplicationConfigDto');
    }

    public function testDoctorApplicationShapes(): void
    {
        $app = new \App\Domain\Entity\DoctorApplication('abroad', 'ada@example.com');
        $app->initTimestamps();
        $app->setNames('Ada', 'Obi');
        $app->markSubmitted('GVM-DR-2026-12345', new DateTimeImmutable('2026-10-20 10:00:00'));
        $app->scheduleInterview(new DateTimeImmutable('2026-10-28T10:00:00+01:00'), 30, 'https://meet.google.com/abc', 'Bring ID');

        $doc = new \App\Domain\Entity\DoctorApplicationDocument($app->getId(), 'government_id', 'applications/' . str_repeat('a', 32) . '.bin', 'id.pdf', 'application/pdf', 10, str_repeat('b', 64));
        $doc->initTimestamps();
        $this->assertKeys(self::APP_DOCUMENT, \App\Infrastructure\Application\ApplicationViews::document($doc, 'abroad'));
        $this->assertKeys([...self::APP_DOCUMENT, 'credential_id', 'sha256'], \App\Infrastructure\Application\ApplicationViews::document($doc, 'abroad', true));
        $this->assertKeys(self::APP_SUBMITTED, \App\Infrastructure\Application\ApplicationViews::submitted($app));
        $row = \App\Infrastructure\Application\ApplicationViews::row($app);
        $this->assertKeys(self::APP_ROW, $row);
        $this->assertSame('Abroad · ', $row['licence_label'], 'no regulator country yet');
        $interview = \App\Infrastructure\Application\ApplicationViews::interview($app);
        $this->assertKeys(self::APP_INTERVIEW, (array) $interview);
        $this->assertSame('Wednesday 28 October, 10:00 WAT', $interview['starts_at_label']);
        $this->assertSame('meet.google.com', $interview['meeting_host']);
        $this->assertKeys(self::APP_SECTIONS, \App\Infrastructure\Application\ApplicationViews::sections($app));

        $request = new \App\Domain\Entity\DoctorApplicationInfoRequest($app->getId(), null, 'Rev', 'Please', [['kind' => 'section', 'key' => 'licence', 'label' => 'Licence']], new DateTimeImmutable());
        $this->assertKeys(self::APP_INFO_REQUEST, $request->toArray());
        $this->assertKeys([...self::APP_INFO_REQUEST, 'requested_by_name', 'closed_at', 'close_reason'], $request->toArray(true));
        $this->assertKeys(self::APP_EVENT, (new \App\Domain\Entity\DoctorApplicationEvent($app->getId(), 'email_sent', 'system', metadata: ['channel' => 'email']))->toArray());
        $note = new \App\Domain\Entity\DoctorApplicationNote($app->getId(), null, 'Rev', 'Body');
        $note->initTimestamps();
        $this->assertKeys(self::APP_NOTE, $note->toArray());
    }

    // ----- Lab requests (libs/shared/models/src/lib/lab-request.ts; Wave 0's key fixture) -----

    /** The lab spec §2 key lists — the fixture, when present, must say the same. */
    public const LAB_KEYS = [
        'doctor_summary' => ['id', 'number', 'status', 'priority', 'appointment_id', 'patient', 'clinical_question', 'tests_label', 'items_count', 'counts',
            'results_count', 'unreviewed_count', 'abnormal', 'sent_at', 'valid_until', 'expires_at', 'last_activity_at'],
        'doctor_detail_extra' => ['appointment_scheduled_at', 'purpose', 'history', 'medication', 'allergies', 'clinical', 'imaging_safety', 'catalogue_version', 'items',
            'prescriber', 'patient_snapshot', 'consent', 'lab_name', 'lab_date', 'declined_at', 'decline_reason', 'sample_at', 'result_ready_at', 'reviewed_at',
            'cancelled_at', 'cancel_reason', 'expired_at', 'duplicated_from', 'results', 'timeline', 'can'],
        'doctor_result'  => ['id', 'uploaded_at', 'item_ids', 'visible', 'reviewable', 'document', 'review'],
        'patient_summary' => ['id', 'number', 'status', 'priority', 'doctor', 'items_count', 'results_count', 'reviewed', 'awaiting_review', 'appointment_id',
            'sent_at', 'valid_until', 'expires_at', 'last_activity_at'],
        'patient_detail_extra' => ['clinical_question', 'purpose', 'items', 'instructions', 'consent_version', 'consent_statements', 'consent', 'lab_name', 'lab_date',
            'declined_at', 'decline_reason', 'sample_at', 'result_ready_at', 'cancelled_at', 'cancel_reason', 'expired_at', 'results_sharing', 'doctor_available',
            'results', 'timeline', 'can', 'result_document_types', 'default_document_type'],
        'patient_result' => ['id', 'uploaded_at', 'item_ids', 'document', 'share_outcome', 'shared_now', 'viewable', 'reviewable', 'review'],
        'admin_row'      => ['id', 'number', 'status', 'priority', 'doctor_name', 'items_count', 'results_count', 'sent_at', 'last_activity_at', 'corrections',
            'consented_on', 'last_correction_note'],
    ];

    public function testTheLabRequestPresentersEmitTheContractKeys(): void
    {
        $catalogue = new \App\Domain\Lab\LabCatalogue(\App\Domain\Lab\LabCatalogue::defaultPath());
        [$form] = \App\Domain\Lab\LabRequestForm::check([
            'client_key' => '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b', 'catalogue_version' => '2026-11.1', 'priority' => 'urgent', 'clinical_question' => 'Chest pain',
            'items' => [['code' => 'TROPI'], ['code' => 'ECG12'], ['code' => 'XR-CHEST']], 'attest' => true, 'signature' => ['mode' => 'saved'],
            // An imaging study, so the nested imaging_safety shape is exercised too.
            'imaging_safety' => ['contrast_allergy' => 'no', 'mobility' => 'walking'],
        ], false, $catalogue);
        $now = new DateTimeImmutable();
        $r   = new \App\Domain\Entity\LabRequest('a0000000-0000-4000-8000-000000000001', 'GVM-REQ-20261104-00012', 'p-1', 's-1', null, null, null, null, $form, '2026-11.1',
            ['id' => 's-1', 'name' => 'Dr. Test', 'specialty' => 'Cardiology', 'qualifications' => '', 'mdcn_number' => '1', 'registration_label' => 'MDCN number'],
            ['name' => 'Pat Patient', 'reference' => 'P-00000000', 'email' => 'p@example.test', 'date_of_birth' => '', 'dob_iso' => '', 'sex' => ''],
            'saved', 'lab-signatures/x', 'b0000000-0000-4000-8000-000000000002', \App\Domain\Lab\LabRequestRules::validity($now), $now);
        foreach ($form['items'] as $n => $snap) {
            $r->addItem(new \App\Domain\Entity\LabRequestItem($r, $n + 1, $snap));
        }
        $r->markAccepted(['version' => \App\Domain\Lab\LabRequestRules::CONSENT_VERSION], true, null, null, $now);
        $result = new \App\Domain\Entity\LabRequestResult($r, 'd-1', $r->itemIds(), true, $now);
        // Reviewed, so both sides' nested review shapes are checked (the patient's
        // must never carry the outcome).
        $result->review('abnormal', 'Please book a follow-up.', 's-1', $now);
        $r->addResult($result);
        $r->addResultCounts($now);
        $doc = $this->document('patient', null);
        $event = new \App\Domain\Entity\LabRequestEvent($r->getId(), 'sent', null, 'awaiting_consent', 'doctor', 's-1', 'Dr. Test', null, $now);

        $keys = self::LAB_KEYS;
        $fixture = dirname(__DIR__, 4) . '/libs/shared/models/src/lib/lab-request-keys.fixture.json';
        if (is_file($fixture)) {
            $json = json_decode((string) file_get_contents($fixture), true);
            $this->assertIsArray($json);
            $this->assertSame([...$keys['doctor_summary'], ...$keys['doctor_detail_extra']], $json['doctor_detail']);
            $this->assertSame([...$keys['patient_summary'], ...$keys['patient_detail_extra']], $json['patient_detail']);
            foreach (['doctor_summary', 'doctor_result', 'patient_summary', 'patient_result', 'admin_row'] as $list) {
                $this->assertSame($keys[$list], $json[$list], $list);
            }
        }

        $L = \App\Infrastructure\Lab\LabRequestPresenter::class;
        $this->assertSame($keys['doctor_summary'], array_keys($L::doctorSummary($r, $now, 0)));
        $detail = $L::doctorDetail($r, $now, ['d-1' => $this->visible($doc)], null, [$event]);
        $this->assertSame([...$keys['doctor_summary'], ...$keys['doctor_detail_extra']], array_keys($detail));
        $this->assertSame($keys['doctor_result'], array_keys($detail['results'][0]));
        $this->assertSame(['title', 'type_label', 'extension', 'size_label', 'viewable'], array_keys($detail['results'][0]['document']));
        $this->assertSame(['event', 'from_status', 'to_status', 'actor_role', 'actor_name', 'at', 'sample_date'], array_keys($detail['timeline'][0]));
        $this->assertSame(['id', 'position', 'code', 'kind', 'category', 'modality', 'site', 'label', 'short', 'specimen_mode', 'specimen_code', 'specimen_label',
            'preparation_code', 'preparation_label', 'contrast_possible', 'ionising'], array_keys($detail['items'][0]));
        $this->assertSame(['id', 'name', 'specialty', 'qualifications', 'registration_label', 'registration_number'], array_keys($detail['prescriber']));
        $this->assertSame(['name', 'reference', 'email', 'date_of_birth', 'age', 'sex'], array_keys($detail['patient_snapshot']));
        $this->assertSame(['cancel', 'review', 'duplicate'], array_keys($detail['can']));

        $this->assertSame($keys['patient_summary'], array_keys($L::patientSummary($r, $now, ['reviewed' => false, 'awaiting_review' => false])));
        $patient = $L::patient($r, $now, ['d-1' => $doc], ['d-1' => true], true, 'active', [$event], $catalogue);
        $this->assertSame([...$keys['patient_summary'], ...$keys['patient_detail_extra']], array_keys($patient));
        $this->assertSame($keys['patient_result'], array_keys($patient['results'][0]));
        $this->assertSame(['id', 'title', 'type_label', 'extension', 'size_label'], array_keys($patient['results'][0]['document']));
        $this->assertSame(['id', 'kind', 'label', 'short', 'specimen_label', 'preparation_code', 'preparation_label'], array_keys($patient['items'][0]));
        $this->assertSame(['accept', 'decline', 'sample', 'upload', 'pdf'], array_keys($patient['can']));
        $this->assertSame($keys['admin_row'], array_keys($L::admin($r, $now, null, false)));

        // The TypeScript contract's nested sections ("<section>.<field>") against the
        // real presenter output: a renamed or leaked nested key fails here too.
        if (isset($json)) {
            $bases = [
                'doctor_summary' => $detail, 'doctor_detail' => $detail, 'doctor_result' => $detail['results'][0],
                'patient_summary' => $patient, 'patient_detail' => $patient, 'patient_result' => $patient['results'][0],
            ];
            $unchecked = [];
            foreach ($json as $section => $expected) {
                if (!str_contains($section, '.')) {
                    continue;
                }
                [$base, $field] = explode('.', $section, 2);
                $this->assertArrayHasKey($base, $bases, "no presenter output mapped for {$section}");
                $this->assertArrayHasKey($field, $bases[$base], $section);
                $value = $bases[$base][$field];
                if (is_array($value) && array_is_list($value)) {
                    $value = $value[0] ?? null;
                }
                if ($value === null) {
                    $unchecked[] = $section;
                    continue;
                }
                $this->assertIsArray($value, $section);
                $this->assertSame($expected, array_keys($value), $section);
            }
            // The sample request fills every nested section, so none may go unchecked.
            $this->assertSame([], $unchecked, 'nested contract sections left unchecked');
            $this->assertArrayNotHasKey('outcome', $patient['results'][0]['review']);
        }
    }

    private function assertKeys(array $expected, array $actual): void
    {
        $keys = array_keys($actual);
        sort($keys);
        sort($expected);
        $this->assertSame($expected, $keys);
    }

    private function doctor(string $id): Specialist
    {
        $s = new Specialist('Dr. Test', 'General Practice');
        (new \ReflectionProperty(Specialist::class, 'id'))->setValue($s, $id);

        return $s;
    }

    private function appointment(Specialist $s): Appointment
    {
        $p = new Patient('p@example.test', 'Pat', 'Patient');
        (new \ReflectionProperty(Patient::class, 'id'))->setValue($p, 'p-1');
        $a = new Appointment($p, $s, new DateTimeImmutable('+2 days'), ConsultationType::VIDEO);
        (new \ReflectionProperty(Appointment::class, 'status'))->setValue($a, AppointmentStatus::CONFIRMED);

        return $a;
    }

    private function document(string $uploader, ?string $appointmentId): MedicalDocument
    {
        $doc = new MedicalDocument('p-1', $uploader, 'Pat Patient', 'blood_test_report', 'HIV test result', 'x.pdf', 'application/pdf', 'pdf', 100);
        (new \ReflectionProperty(MedicalDocument::class, 'createdAt'))->setValue($doc, new DateTimeImmutable('2026-10-20 10:00:00'));
        if ($appointmentId !== null) {
            $a = $this->appointment($this->doctor('s-1'));
            (new \ReflectionProperty(Appointment::class, 'id'))->setValue($a, $appointmentId);
            $doc->setAppointment($a);
        }

        return $doc;
    }

    private function visible(MedicalDocument $doc): VisibleDocument
    {
        return new VisibleDocument('d-1', $doc, null, null, true, 'folder', 'g-1', new DateTimeImmutable('2026-10-20 10:00:00'), ['g-1']);
    }

    /** @param array<string,mixed> $over @return array<string,mixed> */
    private function grantRow(array $over = []): array
    {
        return $over + [
            'id' => 'g-1', 'patient_id' => 'p-1', 'specialist_id' => 's-1', 'scope' => 'selected', 'status' => 'active', 'source' => 'share', 'surface' => 'manage_sharing',
            'consent_version' => '2026-10.1', 'duration' => '7d', 'starts_at' => self::stored('2026-10-21T09:00:00Z'), 'expires_at' => self::stored('2026-10-28T09:00:00Z'), 'original_expires_at' => null,
            'appointment_id' => null, 'request_id' => null, 'client_key' => null, 'request_hash' => null, 'revoke_batch_id' => null, 'restored_at' => null,
            'restored_from_grant_id' => null, 'ended_at' => null, 'end_reason' => null, 'ended_by' => null, 'last_accessed_at' => null, 'access_count' => 0,
            'created_at' => self::stored('2026-10-21T09:00:00Z'), 'updated_at' => self::stored('2026-10-21T09:00:00Z'),
        ];
    }

    /** What a timestamp column holds for `$instant`: its naive wall-clock on the process clock. */
    private static function stored(string $instant): string
    {
        return Rules::sql(new DateTimeImmutable($instant));
    }
}
