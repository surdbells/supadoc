<?php

declare(strict_types=1);

namespace App\Tests\Integration\Lab;

use App\Action\LabRequest\Doctor\CancelLabRequestAction;
use App\Action\LabRequest\Doctor\CreateLabRequestAction;
use App\Action\LabRequest\Patient\DeclineLabRequestAction;
use App\Action\LabRequest\Patient\GetMyLabRequestAction;
use App\Action\LabRequest\Patient\ListMyLabRequestsAction;
use App\Action\LabRequest\Patient\ReportLabSampleAction;
use App\Action\LabRequest\Patient\UploadLabResultAction;
use App\Domain\Document\DocumentSharingRules as Rules;
use App\Domain\Entity\Specialist;
use App\Domain\Lab\LabRequestRules;
use App\Infrastructure\Document\DocumentAccessPolicy;
use App\Infrastructure\Document\DocumentSharingService;
use App\Infrastructure\Document\VisibleDocument;
use Doctrine\ORM\EntityManagerInterface;
use Ramsey\Uuid\Uuid;

/**
 * The patient's side (lab spec §2.3, §1.9, §8.1): lists scoped to the
 * patient, the detail without clinical flags or outcomes, accept / decline /
 * sample, and result uploads — one transaction with the request's sharing
 * grant (whole-folder holders asked, an ended grant rotated), every refusal
 * storing nothing, races included.
 */
final class PatientLabRequestTest extends LabTestCase
{
    public function testListsAndCountsAreThePatientsOwn(): void
    {
        $mine = $this->booked();
        $this->sent();
        $theirs = $this->sent(['patient_id' => $this->Q, 'clinical' => ['infection_alerts' => []]]);
        $this->assertSame(200, $this->accept($theirs, [], $this->Q)['status']);
        $this->assertSame(200, $this->patientAction(ReportLabSampleAction::class, $this->Q, [], ['labId' => $theirs])['status']);

        $all = $this->patientAction(ListMyLabRequestsAction::class, $this->P, [], [], [], 'GET')['body'];
        $this->assertSame(['all' => 2, 'awaiting_patient' => 1, 'in_progress' => 1, 'result_ready' => 0], $all['meta']['counts']);
        foreach (LabRequestRules::GROUPS as $group) {
            $rows = $this->patientAction(ListMyLabRequestsAction::class, $this->P, [], [], ['group' => $group], 'GET')['body']['data'];
            $this->assertNotContains($theirs, array_column($rows, 'id'), $group);
            $this->assertSame($all['meta']['counts'][$group], count($rows), $group);
        }
        $row = $all['data'][array_search($mine, array_column($all['data'], 'id'), true)];
        $this->assertSame(['id', 'number', 'status', 'priority', 'doctor', 'items_count', 'results_count', 'reviewed', 'awaiting_review', 'appointment_id', 'sent_at', 'valid_until', 'expires_at', 'last_activity_at'], array_keys($row));
        $this->assertSame(['all' => 1, 'awaiting_patient' => 0, 'in_progress' => 1, 'result_ready' => 0], $this->patientAction(ListMyLabRequestsAction::class, $this->Q, [], [], [], 'GET')['body']['meta']['counts']);
        $this->assertSame(404, $this->patientAction(GetMyLabRequestAction::class, $this->P, [], ['labId' => $theirs], [], 'GET')['status']);
    }

    public function testTheDetailNeverCarriesAnOutcomeOrClinicalFlags(): void
    {
        $id  = $this->sent(['items' => [['code' => 'FBS'], ['code' => 'US-PELVIS']], 'imaging_safety' => ['contrast_allergy' => 'yes', 'mobility' => 'walking'],
            'clinical' => ['fasting' => true, 'fasting_hours' => 8, 'pregnant' => false, 'infection_alerts' => ['hiv', 'tb'], 'transfusion_3m' => true]]);
        $dto = $this->patientAction(GetMyLabRequestAction::class, $this->P, [], ['labId' => $id], [], 'GET')['body']['data'];
        foreach (['clinical', 'history', 'medication', 'allergies', 'imaging_safety', 'abnormal', 'prescriber'] as $key) {
            $this->assertArrayNotHasKey($key, $dto, $key);
        }
        $this->assertStringNotContainsString('hiv', strtolower((string) json_encode($dto['items'])));
        $this->assertSame(['tests', 'pays_lab', 'lab_disclosure', 'share_results'], array_column($dto['consent_statements'], 'key'));
        $this->assertStringContainsString('Dr. Ada Alpha', $dto['consent_statements'][3]['text']);
        $this->assertSame(['fasting', 'preparation_full_bladder', 'bring'], array_column($dto['instructions'], 'key'), 'no contrast line: an ultrasound never takes contrast');
        $this->assertSame(['accept' => true, 'decline' => true, 'sample' => false, 'upload' => false, 'pdf' => false], $dto['can']);
        $this->assertSame('laboratory_test_report', $dto['default_document_type'], 'a mix of lab and imaging');
        $this->assertSame('none', $dto['results_sharing']);
        $this->assertTrue($dto['doctor_available']);
    }

    public function testAcceptRecordsTheConsentAndChecksThePlannedDate(): void
    {
        $id = $this->sent();
        $this->assertSame(409, $this->accept($id, ['consent_version' => 'LAB-2026-10.1'])['status']);
        $missing = $this->accept($id, ['agree_disclosure' => false]);
        $this->assertSame(422, $missing['status']);
        $this->assertSame('Tick the three required boxes to accept.', $missing['body']['errors']['agree']);

        $validUntil = (string) $this->conn()->fetchOne('SELECT valid_until FROM lab_requests WHERE id = ?', [$id]);
        $after      = (new \DateTimeImmutable($validUntil))->modify('+1 day')->format('Y-m-d');
        $late       = $this->accept($id, ['lab_date' => $after]);
        $this->assertSame(422, $late['status']);
        $this->assertSame('Choose a date before this request expires on ' . LabRequestRules::dateLabel(new \DateTimeImmutable($validUntil)), $late['body']['errors']['lab_date']);
        $yesterday = (new \DateTimeImmutable(\App\Domain\Settings\ClinicTime::todayYmd()))->modify('-1 day')->format('Y-m-d');
        $early     = (new \DateTimeImmutable($yesterday))->modify('-1 day')->format('Y-m-d');
        $this->assertSame('Choose today or a later date', $this->accept($id, ['lab_date' => $early])['body']['errors']['lab_date'] ?? null);

        $ok = $this->accept($id, ['lab_name' => 'Synlab Ikeja', 'lab_date' => $validUntil, 'share_results' => false]);
        $this->assertSame(200, $ok['status'], json_encode($ok['body']));
        $this->assertSame('Request accepted', $ok['body']['message']);
        $dto = $ok['body']['data'];
        $this->assertSame('booked', $dto['status']);
        $this->assertSame($validUntil, $dto['lab_date']);
        $this->assertFalse($dto['consent']['share_results']);
        $this->assertTrue($dto['can']['pdf']);
        $consent = json_decode((string) $this->conn()->fetchOne('SELECT CAST(consent AS TEXT) FROM lab_requests WHERE id = ?', [$id]), true);
        $this->assertSame(['version' => 'LAB-2026-11.1', 'tests' => true, 'pays_lab' => true, 'lab_disclosure' => true, 'share_results' => false], $consent);
        $this->assertSame(1, $this->countRows("SELECT COUNT(*) FROM staff_notifications WHERE title = 'Lab request accepted'"));
        $this->assertSame(200, $this->acceptYesterday(), 'clinic yesterday is accepted');
    }

    public function testDeclineAndSample(): void
    {
        $declined = $this->sent();
        $res      = $this->patientAction(DeclineLabRequestAction::class, $this->P, ['reason' => "I'll do these tests next month"], ['labId' => $declined]);
        $this->assertSame(200, $res['status']);
        $this->assertSame('declined', $res['body']['data']['status']);
        $this->assertSame(409, $this->accept($declined)['status']);

        $booked = $this->booked();
        $this->assertSame(409, $this->patientAction(ReportLabSampleAction::class, $this->P, [], ['labId' => $this->sent()])['status'], 'not accepted yet');
        $sample = $this->patientAction(ReportLabSampleAction::class, $this->P, [], ['labId' => $booked]);
        $this->assertSame(200, $sample['status']);
        $this->assertSame('in_lab', $sample['body']['data']['status']);
        $this->assertSame(1, $this->countRows("SELECT COUNT(*) FROM staff_notifications WHERE title = 'Sample given'"));
    }

    public function testASharedUploadCreatesOneGrantPerRequestAndLaterResultsJoinIt(): void
    {
        $id    = $this->booked();
        $first = $this->upload($id);
        $this->assertSame(201, $first['status'], json_encode($first['body']));
        $this->assertSame('Result added', $first['body']['message']);
        $result = $first['body']['data']['result'];
        $this->assertSame('shared', $result['share_outcome']);
        $this->assertTrue($result['shared_now']);
        $this->assertTrue($result['reviewable']);
        $key   = (string) $this->conn()->fetchOne('SELECT result_share_key FROM lab_requests WHERE id = ?', [$id]);
        $grant = $this->conn()->fetchAssociative("SELECT scope, source, surface, duration, client_key, expires_at FROM document_access_grants WHERE status = 'active'");
        $this->assertSame(['scope' => 'selected', 'source' => 'upload', 'surface' => 'lab_request', 'duration' => 'indefinite', 'client_key' => $key, 'expires_at' => null], $grant);
        $this->assertSame([$result['document']['id']], $this->visible($this->A));
        $this->assertSame('active', $first['body']['data']['request']['results_sharing']);
        $this->assertSame('result_ready', $first['body']['data']['request']['status']);

        $second = $this->upload($id);
        $this->assertSame('shared', $second['body']['data']['result']['share_outcome']);
        $this->assertSame(1, $this->countRows('SELECT COUNT(*) FROM document_access_grants'), 'one grant');
        $this->assertCount(2, $this->visible($this->A));
        $this->assertGreaterThan(0, $this->countRows("SELECT COUNT(*) FROM document_access_log WHERE details::text LIKE '%lab_request%'"), 'the ledger names the surface');
        $this->assertSame(2, $this->countRows("SELECT COUNT(*) FROM audit_events WHERE action = 'lab_result.added'"));
        $detail = $second['body']['data']['request'];
        $this->assertTrue($detail['awaiting_review']);
        $this->assertFalse($detail['reviewed']);
    }

    public function testNotSharingKeepsItPrivateEvenFromAFolderHolderDoctor(): void
    {
        $id      = $this->booked();
        $private = $this->upload($id, null, ['share' => '0']);
        $this->assertSame('private', $private['body']['data']['result']['share_outcome']);
        $this->assertSame(0, $this->countRows('SELECT COUNT(*) FROM document_access_grants'));
        $this->assertFalse($private['body']['data']['request']['awaiting_review'], 'nothing reviewable');
        $this->assertFalse($private['body']['data']['request']['reviewed']);

        $this->folderShare($this->A);
        $this->assertNotContains($private['body']['data']['result']['document']['id'], $this->visible($this->A), 'a result kept private stays hidden from a later folder share');
        $hidden = $this->upload($id, null, ['share' => '0']);
        $this->assertSame('private', $hidden['body']['data']['result']['share_outcome']);
        $this->assertNotContains($hidden['body']['data']['result']['document']['id'], $this->visible($this->A), 'kept out with a hidden row');
    }

    public function testOtherFolderHoldersAreAskedAtUpload(): void
    {
        $id = $this->booked();
        $this->folderShare($this->B);
        $kept = $this->upload($id, null, ['exclude_specialist_ids' => [$this->B]]);
        $this->assertSame(201, $kept['status'], json_encode($kept['body']));
        $this->assertNotContains($kept['body']['data']['result']['document']['id'], $this->visible($this->B));
        $shown = $this->upload($id);
        $this->assertContains($shown['body']['data']['result']['document']['id'], $this->visible($this->B));

        $before = $this->storedFiles();
        $bad    = $this->upload($id, null, ['exclude_specialist_ids' => [$this->C]]);
        $this->assertSame(422, $bad['status']);
        $this->assertSame("You can only keep files from doctors you've booked.", $bad['body']['errors']['exclude_specialist_ids.0']);
        $this->assertSame($before, $this->storedFiles(), 'nothing stored');
    }

    public function testStopSharingAndUndoThenSharingAgainRotatesTheKey(): void
    {
        $id = $this->booked();
        $this->upload($id);
        $oldKey = (string) $this->conn()->fetchOne('SELECT result_share_key FROM lab_requests WHERE id = ?', [$id]);
        [$svc, $patient] = $this->sharing();
        $revoked = $svc->stopSharing($patient, $this->A, Rules::now());
        [$svc, $patient] = $this->sharing();
        $svc->restore($patient, (string) $revoked['revoked'][0]['id'], Rules::now());
        $this->assertSame('ended', $this->detailOf($id)['results_sharing'], 'the Undo restores without the key');

        $again = $this->upload($id, null, ['share' => '1']);
        $this->assertSame('shared', $again['body']['data']['result']['share_outcome'], json_encode($again['body']));
        $newKey = (string) $this->conn()->fetchOne('SELECT result_share_key FROM lab_requests WHERE id = ?', [$id]);
        $this->assertNotSame($oldKey, $newKey);
        $this->assertSame(1, $this->countRows("SELECT COUNT(*) FROM document_access_grants WHERE status = 'active' AND client_key = ?", [$newKey]));
        $details = json_decode((string) $this->conn()->fetchOne("SELECT CAST(details AS TEXT) FROM lab_request_events WHERE event = 'result_added' AND details::text LIKE '%share_key_rotated%'"), true);
        $this->assertTrue($details['share_key_rotated']);
        $this->assertSame('active', $this->detailOf($id)['results_sharing']);
    }

    public function testAfterRemovingAccessToTheOnlyResultTheNextUploadIsShared(): void
    {
        $id    = $this->booked();
        $first = $this->upload($id);
        [$svc, $patient] = $this->sharing();
        $svc->removeDocumentAccess($patient, $first['body']['data']['result']['document']['id'], $this->A, Rules::now());
        $this->assertSame('ended', $this->detailOf($id)['results_sharing']);
        $this->assertSame('private', $this->upload($id)['body']['data']['result']['share_outcome'], 'an ended grant: the default is not to share');
        $next = $this->upload($id, null, ['share' => '1']);
        $this->assertSame('shared', $next['body']['data']['result']['share_outcome']);
        $this->assertContains($next['body']['data']['result']['document']['id'], $this->visible($this->A));
        $this->assertNotContains($first['body']['data']['result']['document']['id'], $this->visible($this->A), 'the removed one stays hidden');
    }

    public function testAfterALongPauseAndReinstatementTheNextUploadIsShared(): void
    {
        $id = $this->booked();
        $this->upload($id);
        $this->suspend($this->A, Rules::now()->modify('-40 days'));
        $this->conn()->executeStatement("UPDATE specialists SET status = 'approved' WHERE id = ?", [$this->A]);
        $c  = $this->container();
        $em = $c->get(EntityManagerInterface::class);
        $doctor = $em->find(Specialist::class, $this->A);
        \assert($doctor instanceof Specialist);
        $c->get(DocumentSharingService::class)->doctorReinstated($doctor, Rules::now());
        $this->assertSame('ended', $this->detailOf($id)['results_sharing']);
        $this->assertSame('shared', $this->upload($id, null, ['share' => '1'])['body']['data']['result']['share_outcome']);
    }

    public function testWithSharingSwitchedOffTheResultIsKeptPrivately(): void
    {
        $id = $this->booked();
        $_ENV['DOC_SHARING_ENABLED'] = 'false';
        $res = $this->upload($id);
        $this->assertSame(201, $res['status'], json_encode($res['body']));
        $this->assertSame('sharing_unavailable', $res['body']['data']['result']['share_outcome']);
        $this->assertSame(0, $this->countRows('SELECT COUNT(*) FROM document_access_grants'));
    }

    public function testASuspendedDoctorGetsNothingAndTheResultStaysPrivate(): void
    {
        $id = $this->booked();
        $this->suspend($this->A, Rules::now());
        $res = $this->upload($id);
        $this->assertSame(201, $res['status'], json_encode($res['body']));
        $this->assertSame('doctor_unavailable', $res['body']['data']['result']['share_outcome']);
        $this->assertFalse($res['body']['data']['result']['shared_now']);
        $this->assertFalse($res['body']['data']['request']['doctor_available']);
        $this->assertSame('result_ready', $res['body']['data']['request']['status']);
        $this->assertSame(0, $this->countRows('SELECT COUNT(*) FROM document_access_grants'));
        $this->assertFalse($res['body']['data']['request']['awaiting_review']);
    }

    public function testADoctorNoLongerBookedWithThePatientLeavesTheUploadPrivate(): void
    {
        $send = $this->sendBody(['signature' => ['mode' => 'drawn', 'image' => 'data:image/png;base64,' . base64_encode($this->signaturePng())]]);
        $lab  = $this->doctorAction(CreateLabRequestAction::class, $this->userB, [], $send);
        $this->assertSame(201, $lab['status'], json_encode($lab['body']));
        $id = $lab['body']['data']['id'];
        $this->assertSame(200, $this->accept($id)['status']);
        $this->conn()->executeStatement('UPDATE appointments SET deleted_at = ? WHERE id = ?', [Rules::sql(Rules::now()), $this->bpPast]);
        $res = $this->upload($id);
        $this->assertSame(201, $res['status'], json_encode($res['body']));
        $this->assertSame('doctor_unavailable', $res['body']['data']['result']['share_outcome']);
    }

    public function testRefusedUploadsStoreNothing(): void
    {
        $notYet = $this->sent();
        $before = $this->storedFiles();
        $res    = $this->upload($notYet);
        $this->assertSame(409, $res['status']);
        $this->assertSame('Accept the request before adding a result.', $res['body']['message']);

        $id  = $this->booked();
        $mov = $this->upload($id, $this->file('clip.mov', str_repeat('x', 200), 'video/quicktime'));
        $this->assertSame(422, $mov['status']);
        $this->assertSame('Upload a PDF, photo (JPG, PNG, WEBP), DICOM (.dcm) or Word file.', $mov['body']['errors']['file']);
        $this->assertSame(422, $this->upload($id, null, ['document_type' => 'vaccination_record'])['status']);
        $this->assertSame(422, $this->upload($id, null, ['item_ids' => [Uuid::uuid4()->toString()]])['status']);
        $this->assertSame($before, $this->storedFiles());
        $this->assertSame(0, $this->countRows('SELECT COUNT(*) FROM medical_documents'));

        for ($i = 0; $i < LabRequestRules::MAX_RESULTS; ++$i) {
            $this->assertSame(201, $this->upload($id)['status']);
        }
        $files    = $this->storedFiles();
        $eleventh = $this->upload($id);
        $this->assertSame(422, $eleventh['status']);
        $this->assertSame('You can add up to 10 result files to one request.', $eleventh['body']['errors']['results']);
        $this->assertSame($files, $this->storedFiles(), 'no bytes left');
        $this->assertSame(10, $this->countRows('SELECT COUNT(*) FROM medical_documents'));
    }

    public function testUploadsAfterExpiryOrACancelWhenTheSampleWasGiven(): void
    {
        $expired = $this->booked();
        $this->conn()->executeStatement('UPDATE lab_requests SET valid_until = ?, expires_at = ? WHERE id = ?', [
            Rules::now()->modify('-3 days')->format('Y-m-d'), Rules::sql(Rules::now()->modify('-1 hour')), $expired,
        ]);
        $this->assertSame('expired', $this->detailOf($expired)['status']);
        $res = $this->upload($expired);
        $this->assertSame(201, $res['status'], json_encode($res['body']));
        $this->assertSame('result_ready', $res['body']['data']['request']['status']);

        $cancelled = $this->booked();
        $this->patientAction(ReportLabSampleAction::class, $this->P, [], ['labId' => $cancelled]);
        $this->doctorAction(CancelLabRequestAction::class, $this->userA, ['labId' => $cancelled], ['reason' => 'No longer needed']);
        $this->assertTrue($this->detailOf($cancelled)['can']['upload']);
        $after = $this->upload($cancelled);
        $this->assertSame(201, $after['status'], json_encode($after['body']));
        $this->assertSame('cancelled', $after['body']['data']['request']['status']);
        $this->assertSame(2, $this->countRows("SELECT COUNT(*) FROM staff_notifications WHERE title = 'Result ready for review'"), 'the doctor is told');

        $noSample = $this->booked();
        $this->doctorAction(CancelLabRequestAction::class, $this->userA, ['labId' => $noSample], ['reason' => 'No longer needed']);
        $refused = $this->upload($noSample);
        $this->assertSame(409, $refused['status']);
        $this->assertSame('This request was cancelled.', $refused['body']['message']);
    }

    public function testConcurrentTenthAndEleventhUploadsLeaveTenResults(): void
    {
        $id = $this->booked();
        for ($i = 0; $i < LabRequestRules::MAX_RESULTS - 1; ++$i) {
            $this->assertSame(201, $this->upload($id)['status']);
        }
        $job     = ['op' => 'patient_action', 'class' => UploadLabResultAction::class, 'customer_id' => $this->P, 'args' => ['labId' => $id],
            'body' => ['share' => '1'], 'file' => ['path' => $this->pdfPath(), 'name' => 'late.pdf', 'mime' => 'application/pdf']];
        $results  = $this->race($id, [$job, $job]);
        $statuses = array_map(static fn (array $r): int => (int) ($r['result']['status'] ?? 500), $results);
        sort($statuses);
        $this->assertSame([201, 422], $statuses, json_encode($results));
        $this->assertSame(10, (int) $this->conn()->fetchOne('SELECT results_count FROM lab_requests WHERE id = ?', [$id]));
        $this->assertSame(10, $this->countRows('SELECT COUNT(*) FROM medical_documents'));
        $this->assertSame(10, $this->storedFiles());
    }

    public function testACancelThatLandsFirstLeavesNothingOfTheUpload(): void
    {
        $id      = $this->booked();
        $results = $this->race($id, [
            ['op' => 'doctor_action', 'class' => CancelLabRequestAction::class, 'user_id' => $this->userA, 'args' => ['labId' => $id], 'body' => ['reason' => 'Ordered by mistake']],
            ['op' => 'patient_action', 'class' => UploadLabResultAction::class, 'customer_id' => $this->P, 'args' => ['labId' => $id], 'body' => ['share' => '1'],
                'file' => ['path' => $this->pdfPath(), 'name' => 'result.pdf', 'mime' => 'application/pdf']],
        ]);
        $this->assertSame(200, $results[0]['result']['status'] ?? null, json_encode($results));
        $this->assertSame(409, $results[1]['result']['status'] ?? null, json_encode($results));
        $this->assertSame('status_changed', $results[1]['result']['body']['errors']['code']);
        $this->assertSame(0, $this->countRows('SELECT COUNT(*) FROM document_access_grants'));
        $this->assertSame(0, $this->countRows('SELECT COUNT(*) FROM medical_documents'));
        $this->assertSame(0, $this->storedFiles());
    }

    public function testADocxResultIsNeverAwaitingReview(): void
    {
        $id  = $this->booked();
        $res = $this->upload($id, $this->docx());
        $this->assertSame(201, $res['status'], json_encode($res['body']));
        $this->assertSame('shared', $res['body']['data']['result']['share_outcome']);
        $this->assertFalse($res['body']['data']['result']['viewable']);
        $this->assertFalse($res['body']['data']['result']['reviewable']);
        $this->assertFalse($res['body']['data']['request']['awaiting_review']);
        $list = $this->patientAction(ListMyLabRequestsAction::class, $this->P, [], [], [], 'GET')['body']['data'];
        $this->assertFalse($list[0]['awaiting_review']);
        $this->assertFalse($list[0]['reviewed']);
    }

    // ----- helpers -----

    /** @return list<string> the document ids doctor `$doctorId` sees of P now */
    private function visible(string $doctorId): array
    {
        $c      = $this->container();
        $em     = $c->get(EntityManagerInterface::class);
        $doctor = $em->find(Specialist::class, $doctorId);
        \assert($doctor instanceof Specialist);

        return array_map(static fn (VisibleDocument $v): string => $v->documentId, $c->get(DocumentAccessPolicy::class)->visibleDocuments($doctor, $this->patient($em, $this->P), Rules::now()));
    }

    /** @return array{0: DocumentSharingService, 1: \App\Domain\Entity\Patient} */
    private function sharing(): array
    {
        $c = $this->container();

        return [$c->get(DocumentSharingService::class), $this->patient($c->get(EntityManagerInterface::class), $this->P)];
    }

    /** @return array<string,mixed> */
    private function detailOf(string $id): array
    {
        return $this->patientAction(GetMyLabRequestAction::class, $this->P, [], ['labId' => $id], [], 'GET')['body']['data'];
    }

    private function suspend(string $specialistId, \DateTimeImmutable $at): void
    {
        $this->conn()->executeStatement("UPDATE specialists SET status = 'suspended', suspended_at = ? WHERE id = ?", [Rules::sql($at), $specialistId]);
        $this->conn()->executeStatement(
            "INSERT INTO specialist_status_events (id, specialist_id, from_status, to_status, actor_id, actor_name, created_at) VALUES (?, ?, 'approved', 'suspended', NULL, 'System', ?)",
            [Uuid::uuid4()->toString(), $specialistId, Rules::sql($at)],
        );
    }

    /** Accepting with clinic yesterday as the planned date. */
    private function acceptYesterday(): int
    {
        $id = $this->sent();

        return $this->accept($id, ['lab_date' => (new \DateTimeImmutable(\App\Domain\Settings\ClinicTime::todayYmd()))->modify('-1 day')->format('Y-m-d')])['status'];
    }
}
