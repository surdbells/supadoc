<?php

declare(strict_types=1);

namespace App\Tests\Integration\Lab;

use App\Action\Doctor\CreateLabOrderAction;
use App\Action\LabRequest\Doctor\CancelLabRequestAction;
use App\Action\LabRequest\Doctor\CreateLabRequestAction;
use App\Action\LabRequest\Doctor\DoctorLabRequestLinkAction;
use App\Action\LabRequest\Doctor\GetDoctorLabRequestAction;
use App\Action\LabRequest\Doctor\LabContextAction;
use App\Action\LabRequest\Doctor\LabOptionsAction;
use App\Action\LabRequest\Doctor\LabPatientsAction;
use App\Action\LabRequest\Doctor\ListDoctorLabRequestsAction;
use App\Action\LabRequest\Doctor\ReviewLabResultAction;
use App\Action\LabRequest\Patient\ReportLabSampleAction;
use App\Domain\Entity\Patient;
use App\Domain\Lab\LabCatalogue;
use App\Domain\Lab\LabRequestRules;
use App\Infrastructure\Document\DocumentSharingService;
use App\Infrastructure\Lab\LabRequestNumberGenerator;
use App\Infrastructure\Service\ConsultationCompleter;
use App\Tests\Integration\Lab\Support\LabHarness;
use DateTimeImmutable;
use Doctrine\ORM\EntityManagerInterface;
use Ramsey\Uuid\Uuid;

/**
 * The requesting doctor's side (lab spec §2.2, §8.1): send (numbered, signed,
 * idempotent under a lock), the access rules, the lists and their scoping,
 * cancel, review of results they can open, the STAT / urgent email and the
 * retired lab orders.
 */
final class DoctorLabRequestTest extends LabTestCase
{
    public function testSendNumbersSignsSnapshotsAndTellsThePatient(): void
    {
        $res = $this->send([
            'priority'       => 'stat',
            'items'          => [['code' => 'FBC'], ['code' => 'GRAM-BLOOD'], ['code' => 'XR-CHEST'], ['code' => 'ECG12']],
            'imaging_safety' => ['contrast_allergy' => 'no', 'mobility' => 'walking'],
        ]);
        $this->assertSame(201, $res['status'], json_encode($res['body']));
        $this->assertSame('Request sent', $res['body']['message']);
        $dto = $res['body']['data'];
        $this->assertTrue(LabRequestNumberGenerator::isValid($dto['number']));
        $this->assertSame('awaiting_consent', $dto['status']);
        $this->assertSame(['lab' => 2, 'imaging' => 1, 'physiological' => 1], $dto['counts']);
        $this->assertSame('FBC, Gram stain - Blood, X-Ray - Chest, ECG (12-lead)', $dto['tests_label']);
        $byCode = array_column($dto['items'], null, 'code');
        $this->assertTrue($byCode['XR-CHEST']['ionising']);
        $this->assertSame('none', $byCode['XR-CHEST']['preparation_code']);
        $this->assertSame('blood_culture', $byCode['GRAM-BLOOD']['specimen_code']);
        $this->assertSame('Whole blood (EDTA)', $byCode['FBC']['specimen_label']);
        $this->assertSame(['contrast_allergy' => 'no', 'mobility' => 'walking', 'pregnant' => 'no'], $dto['imaging_safety']);
        $this->assertSame(['id', 'name', 'specialty', 'qualifications', 'registration_label', 'registration_number'], array_keys($dto['prescriber']));
        $this->assertSame('P-' . strtoupper(substr(str_replace('-', '', $this->P), 0, 8)), $dto['patient_snapshot']['reference']);

        $row = $this->conn()->fetchAssociative('SELECT signature_key, sent_at, valid_until, expires_at, result_share_key FROM lab_requests WHERE id = ?', [$dto['id']]);
        $this->assertIsArray($row);
        $this->assertStringStartsWith('lab-signatures/', (string) $row['signature_key']);
        $validity = LabRequestRules::validity(new DateTimeImmutable((string) $row['sent_at']));
        $this->assertSame($validity['valid_until']->format('Y-m-d'), (string) $row['valid_until']);
        $this->assertSame($validity['expires_at']->format('Y-m-d H:i:s'), (string) $row['expires_at']);
        $this->assertSame($validity['valid_until']->format('Y-m-d'), $dto['valid_until']);

        $this->assertSame(['sent'], $this->conn()->fetchFirstColumn('SELECT event FROM lab_request_events WHERE lab_request_id = ?', [$dto['id']]));
        $actions = $this->conn()->fetchFirstColumn("SELECT action FROM audit_events WHERE resource_type = 'lab_request' ORDER BY action");
        $this->assertSame(['lab_request.sent', 'signature.used'], $actions);
        $note = $this->conn()->fetchAssociative('SELECT title, body, link FROM notifications');
        $this->assertSame('New lab request', $note['title']);
        $this->assertSame('Dr. Ada Alpha sent you lab request ' . $dto['number'] . ". Open it to review and accept. It's marked STAT (most urgent).", $note['body']);
        $this->assertSame('/dashboard/lab-requests/' . $dto['id'], $note['link']);
        $this->assertSame(1, $this->emails('lab_request_sent'));
    }

    public function testAReplayOfTheSameFormAnswersTheSameRequest(): void
    {
        $body  = $this->sendBody();
        $first = $this->doctorAction(CreateLabRequestAction::class, $this->userA, [], $body);
        $again = $this->doctorAction(CreateLabRequestAction::class, $this->userA, [], ['clinical_question' => '  Suspected iron-deficiency anaemia '] + $body);
        $this->assertSame(201, $first['status']);
        $this->assertSame(200, $again['status'], json_encode($again['body']));
        $this->assertSame('Request already sent', $again['body']['message']);
        $this->assertSame($first['body']['data']['id'], $again['body']['data']['id']);
        $this->assertSame(1, $this->countRows('SELECT COUNT(*) FROM lab_requests'));
        $this->assertSame(1, $this->countRows('SELECT COUNT(*) FROM notifications'), 'told once');
    }

    public function testTheSameKeyWithOtherDetailsIsRefusedAndWritesNothing(): void
    {
        $body = $this->sendBody();
        $this->assertSame(201, $this->doctorAction(CreateLabRequestAction::class, $this->userA, [], $body)['status']);
        foreach ([['patient_id' => $this->Q], ['items' => [['code' => 'MP']]]] as $other) {
            $res = $this->doctorAction(CreateLabRequestAction::class, $this->userA, [], $other + $body);
            $this->assertSame(409, $res['status'], json_encode($res['body']));
            $this->assertSame('idempotency_conflict', $res['body']['errors']['code']);
            $this->assertSame('This form was already sent with different details. Check it and send again.', $res['body']['message']);
        }
        $this->assertSame(1, $this->countRows('SELECT COUNT(*) FROM lab_requests'));
        $this->assertSame(1, $this->countRows('SELECT COUNT(*) FROM lab_request_counters'));
    }

    public function testTwoParallelSendsWithOneKeyMakeOneRequest(): void
    {
        $body    = $this->sendBody();
        $blocker = $this->container()->get(EntityManagerInterface::class)->getConnection();
        $blocker->beginTransaction();
        $blocker->executeQuery('SELECT pg_advisory_xact_lock(' . LabRequestRules::LOCK_NAMESPACE . ', hashtext(:k))', ['k' => strtolower($this->A) . ':' . $body['client_key']]);
        $app     = 'lab_send_' . bin2hex(random_bytes(3));
        $workers = [];
        foreach ([$body, $body] as $job) {
            $workers[] = LabHarness::startWorker(['schema' => self::$schema, 'app' => $app, 'op' => 'doctor_action', 'class' => CreateLabRequestAction::class, 'user_id' => $this->userA, 'body' => $job]);
        }
        LabHarness::awaitLockWaiters($this->em(), $app, 2);
        $blocker->commit();
        $results  = array_map(static fn (array $w): array => LabHarness::finishWorker($w), $workers);
        $statuses = array_map(static fn (array $r): int => (int) ($r['result']['status'] ?? 500), $results);
        sort($statuses);
        $this->assertSame([200, 201], $statuses, json_encode($results));
        $this->assertSame(1, $this->countRows('SELECT COUNT(*) FROM lab_requests'));
    }

    public function testAnotherCatalogueVersionIsRefusedBeforeAnythingIsWritten(): void
    {
        $res = $this->send(['catalogue_version' => '2025-01.1']);
        $this->assertSame(409, $res['status']);
        $this->assertSame(['code' => 'catalogue_changed', 'catalogue_version' => LabCatalogue::VERSION], $res['body']['errors']);
        $this->assertSame(0, $this->countRows('SELECT COUNT(*) FROM lab_requests'));
    }

    public function testEveryFormErrorComesBackAtOnce(): void
    {
        $res = $this->send(['clinical_question' => 'x', 'items' => [], 'attest' => false]);
        $this->assertSame(422, $res['status']);
        $this->assertSame('Complete the request before sending', $res['body']['message']);
        $this->assertSame('Add the provisional diagnosis or clinical question', $res['body']['errors']['clinical_question']);
        $this->assertSame('Add at least one test', $res['body']['errors']['items']);
        $this->assertSame('Confirm these tests are clinically indicated', $res['body']['errors']['attest']);
    }

    public function testAPregnancyAnswerIsRequiredWithImagingWhenItIsAsked(): void
    {
        $res = $this->send([
            'items'          => [['code' => 'XR-CHEST']],
            'imaging_safety' => ['contrast_allergy' => 'no', 'mobility' => 'walking'],
            'clinical'       => ['pregnant' => null, 'infection_alerts' => []],
        ]);
        $this->assertSame(422, $res['status']);
        $this->assertSame('Answer Pregnant? for the imaging safety screen', $res['body']['errors']['clinical.pregnant']);
    }

    public function testAccessRules(): void
    {
        $notConsulted = $this->send(['signature' => ['mode' => 'drawn', 'image' => 'data:image/png;base64,' . base64_encode($this->signaturePng())]], $this->userC);
        $this->assertSame(422, $notConsulted['status']);
        $this->assertSame(['patient_id' => 'You can request tests only for patients you have consulted.', 'code' => 'not_consulted'], $notConsulted['body']['errors']);

        $notYours = $this->send(['appointment_id' => $this->bpPast]);
        $this->assertSame('This consultation is not yours', $notYours['body']['errors']['appointment_id'] ?? null);

        $otherPatient = $this->send(['appointment_id' => $this->aqPast]);
        $this->assertSame(422, $otherPatient['status']);
        $this->assertSame('This consultation is with another patient.', $otherPatient['body']['errors']['appointment_id']);
        $context = $this->doctorAction(LabContextAction::class, $this->userA, [], [], [], 'GET', ['patient_id' => $this->P, 'appointment_id' => $this->aqPast]);
        $this->assertSame(422, $context['status']);
        $this->assertSame('This consultation is with another patient.', $context['body']['errors']['appointment_id']);

        $future = $this->send(['appointment_id' => $this->apNext]);
        $this->assertSame("This consultation hasn't taken place yet.", $future['body']['errors']['appointment_id'] ?? null);

        $qRequest = $this->sent(['patient_id' => $this->Q, 'clinical' => ['infection_alerts' => []]]);
        $dup      = $this->send(['duplicated_from' => $qRequest]);
        $this->assertSame(422, $dup['status']);
        $this->assertSame('This request is for another patient.', $dup['body']['errors']['duplicated_from']);
        $this->assertSame(1, $this->countRows('SELECT COUNT(*) FROM lab_requests'), 'nothing written by a refusal');

        $bound = $this->send(['appointment_id' => $this->apPast]);
        $this->assertSame(201, $bound['status'], json_encode($bound['body']));
        $this->assertSame($this->apPast, $bound['body']['data']['appointment_id']);
    }

    public function testOptionsPickerAndContext(): void
    {
        $options = $this->doctorAction(LabOptionsAction::class, $this->userA, [], [], [], 'GET');
        $this->assertSame(200, $options['status']);
        $this->assertSame(LabCatalogue::VERSION, $options['body']['data']['catalogue_version']);
        $this->assertCount(80, $options['body']['data']['items']);
        $this->assertTrue($options['body']['data']['has_signature']);
        $this->assertSame('no-store', $options['response']->getHeaderLine('Cache-Control'));

        $picks = $this->doctorAction(LabPatientsAction::class, $this->userA, [], [], [], 'GET');
        $this->assertSame(2, $picks['body']['meta']['total'], 'P and Q, both consulted');
        $this->assertSame(0, $this->doctorAction(LabPatientsAction::class, $this->userC, [], [], [], 'GET')['body']['meta']['total']);
        $first = $picks['body']['data'][0];
        $this->assertSame(['patient_id', 'name', 'email', 'reference', 'avatar_url', 'last_visit'], array_keys($first));
        $this->assertNotNull($first['last_visit']);

        $em = $this->em();
        $p  = $em->find(Patient::class, $this->P);
        \assert($p instanceof Patient);
        $p->setMedical(['medications' => [['name' => 'Metformin', 'dosage' => '500 mg']], 'allergies' => [['allergen' => 'Latex', 'severity' => ''], ['allergen' => 'Penicillin', 'severity' => 'severe']]]);
        $em->flush();
        $ctx = $this->doctorAction(LabContextAction::class, $this->userA, [], [], [], 'GET', ['patient_id' => $this->P]);
        $this->assertSame(200, $ctx['status'], json_encode($ctx['body']));
        $this->assertTrue($ctx['body']['data']['ask_pregnancy']);
        $this->assertSame('Female', $ctx['body']['data']['patient']['sex']);
        $this->assertSame(['medication' => 'Metformin 500 mg', 'allergies' => 'Penicillin (severe), Latex'], $ctx['body']['data']['prefill']);
        $this->assertSame(422, $this->doctorAction(LabContextAction::class, $this->userC, [], [], [], 'GET', ['patient_id' => $this->P])['status']);
    }

    public function testListsGroupsCountsSearchAndScopingToTheDoctor(): void
    {
        $awaiting = $this->sent();
        $booked   = $this->booked(['items' => [['code' => 'MP']]]);
        $inLab    = $this->booked(['items' => [['code' => 'TROPI'], ['code' => 'ECG12']]]);
        $this->assertSame(200, $this->patientAction(ReportLabSampleAction::class, $this->P, [], ['labId' => $inLab])['status']);
        // Doctor B's requests (same patient) never show in A's lists or counts.
        $bLab = $this->doctorAction(CreateLabRequestAction::class, $this->userB, [], $this->sendBody(['signature' => ['mode' => 'drawn', 'image' => 'data:image/png;base64,' . base64_encode($this->signaturePng())]]));
        $this->assertSame(201, $bLab['status'], json_encode($bLab['body']));
        $this->accept($bLab['body']['data']['id']);
        $this->patientAction(ReportLabSampleAction::class, $this->P, [], ['labId' => $bLab['body']['data']['id']]);

        // Distinct activity times (the column holds seconds).
        foreach ([$awaiting => '-3 minutes', $booked => '-2 minutes', $inLab => '-1 minute'] as $lab => $ago) {
            $this->conn()->executeStatement('UPDATE lab_requests SET last_activity_at = ? WHERE id = ?', [\App\Domain\Document\DocumentSharingRules::sql($this->now->modify($ago)), $lab]);
        }
        $list = fn (array $q = [], ?string $user = null): array => $this->doctorAction(ListDoctorLabRequestsAction::class, $user ?? $this->userA, [], [], [], 'GET', $q)['body'];
        $all  = $list();
        $this->assertSame(['all' => 3, 'awaiting_patient' => 1, 'in_progress' => 2, 'result_ready' => 0], $all['meta']['counts']);
        $this->assertSame([$inLab, $booked, $awaiting], array_column($all['data'], 'id'), 'most recent activity first');
        foreach (LabRequestRules::GROUPS as $group) {
            $rows = $list(['group' => $group])['data'];
            $this->assertNotContains($bLab['body']['data']['id'], array_column($rows, 'id'), $group);
            $this->assertSame($all['meta']['counts'][$group], count($rows), $group);
        }
        $this->assertSame(['all' => 1, 'awaiting_patient' => 0, 'in_progress' => 1, 'result_ready' => 0], $list([], $this->userB)['meta']['counts']);

        $number = $all['data'][1]['number'];
        $this->assertSame([$booked], array_column($list(['q' => strtolower($number)])['data'], 'id'), 'by number');
        $this->assertSame([$inLab], array_column($list(['q' => 'troponin'])['data'], 'id'), 'by item');
        $this->assertCount(3, $list(['q' => 'pat patient'])['data'], 'by patient name');
        $this->assertSame(422, $this->doctorAction(ListDoctorLabRequestsAction::class, $this->userA, [], [], [], 'GET', ['group' => 'drafts'])['status']);
        $this->assertSame(['in_progress' => 1], array_intersect_key($list(['q' => 'troponin'])['meta']['counts'], ['in_progress' => 0]), 'counts honour q');
    }

    public function testAnotherDoctorsRequestIsNotFound(): void
    {
        $id = $this->sent();
        foreach ([
            [GetDoctorLabRequestAction::class, 'GET', []],
            [CancelLabRequestAction::class, 'POST', ['reason' => 'Wrong patient']],
            [DoctorLabRequestLinkAction::class, 'POST', []],
        ] as [$class, $method, $body]) {
            $res = $this->doctorAction($class, $this->userB, ['labId' => $id], $body, [], $method);
            $this->assertSame(404, $res['status'], $class);
            $this->assertSame('Lab request not found', $res['body']['message']);
        }
        $this->assertSame(404, $this->doctorAction(ReviewLabResultAction::class, $this->userB, ['labId' => $id, 'resultId' => Uuid::uuid4()->toString()], ['outcome' => 'normal'])['status']);
    }

    public function testCancelNeedsAReasonAndAnOpenRequest(): void
    {
        $id = $this->booked();
        $this->assertSame(422, $this->doctorAction(CancelLabRequestAction::class, $this->userA, ['labId' => $id], ['reason' => 'x'])['status']);
        $ok = $this->doctorAction(CancelLabRequestAction::class, $this->userA, ['labId' => $id], ['reason' => 'Ordered for the wrong patient']);
        $this->assertSame(200, $ok['status'], json_encode($ok['body']));
        $this->assertSame('cancelled', $ok['body']['data']['status']);
        $this->assertSame(1, $this->emails('lab_request_cancelled'));

        $withResult = $this->booked();
        $this->assertSame(201, $this->upload($withResult)['status']);
        $late = $this->doctorAction(CancelLabRequestAction::class, $this->userA, ['labId' => $withResult], ['reason' => 'Too late now']);
        $this->assertSame(409, $late['status']);
        $this->assertSame(['code' => 'status_changed', 'status' => 'result_ready'], $late['body']['errors']);
    }

    public function testReviewOnlyWhatTheDoctorCanOpen(): void
    {
        $id = $this->booked();
        // Not shared: the doctor can't see it — and a private result never counts as unreviewed.
        $private = $this->upload($id, null, ['share' => '0']);
        $this->assertSame('private', $private['body']['data']['result']['share_outcome']);
        $privateId = $private['body']['data']['result']['id'];
        $res = $this->doctorAction(ReviewLabResultAction::class, $this->userA, ['labId' => $id, 'resultId' => $privateId], ['outcome' => 'normal']);
        $this->assertSame(409, $res['status']);
        $this->assertSame('not_shared', $res['body']['errors']['code']);
        $this->assertSame(0, $this->detail($id)['unreviewed_count']);

        $docx = $this->upload($id, $this->docx(), ['share' => '1']);
        $this->assertSame('shared', $docx['body']['data']['result']['share_outcome'], json_encode($docx['body']));
        $res = $this->doctorAction(ReviewLabResultAction::class, $this->userA, ['labId' => $id, 'resultId' => $docx['body']['data']['result']['id']], ['outcome' => 'normal']);
        $this->assertSame(409, $res['status']);
        $this->assertSame('not_viewable', $res['body']['errors']['code']);
        $this->assertSame(0, $this->detail($id)['unreviewed_count'], 'an unopenable file never needs review');

        $pdf      = $this->upload($id, null, ['share' => '1']);
        $resultId = $pdf['body']['data']['result']['id'];
        $this->assertSame(1, $this->detail($id)['unreviewed_count']);
        $this->assertTrue($this->detail($id)['can']['review']);
        $missingNote = $this->doctorAction(ReviewLabResultAction::class, $this->userA, ['labId' => $id, 'resultId' => $resultId], ['outcome' => 'abnormal', 'comment' => ' ']);
        $this->assertSame(422, $missingNote['status']);
        $this->assertSame('Add a note for the patient', $missingNote['body']['errors']['comment']);

        $abnormal = $this->doctorAction(ReviewLabResultAction::class, $this->userA, ['labId' => $id, 'resultId' => $resultId], ['outcome' => 'abnormal', 'comment' => 'Low haemoglobin. Please book a follow-up.']);
        $this->assertSame(200, $abnormal['status'], json_encode($abnormal['body']));
        $this->assertTrue($abnormal['body']['data']['abnormal']);
        $this->assertSame(0, $abnormal['body']['data']['unreviewed_count']);
        $normal = $this->doctorAction(ReviewLabResultAction::class, $this->userA, ['labId' => $id, 'resultId' => $resultId], ['outcome' => 'normal']);
        $this->assertFalse($normal['body']['data']['abnormal'], 'latest wins');
        $this->assertSame(2, $this->emails('lab_result_reviewed'), 'the patient is told each time');
        $this->assertSame(2, $this->countRows("SELECT COUNT(*) FROM notifications WHERE title = 'Your doctor reviewed your result'"));
        $metas = array_map(static fn ($m): array => json_decode((string) $m, true), $this->conn()->fetchFirstColumn("SELECT CAST(metadata AS TEXT) FROM audit_events WHERE action = 'lab_result.reviewed'"));
        $this->assertSame(['number', 'result_id', 'changed', 'patient_id'], array_keys($metas[0]));
        $changed = array_column($metas, 'changed');
        sort($changed);
        $this->assertSame([false, true], $changed, 'the second save changed the first');
    }

    public function testAReviewIsAllowedOnACancelledRequestHoldingAResult(): void
    {
        $id = $this->booked();
        $this->patientAction(ReportLabSampleAction::class, $this->P, [], ['labId' => $id]);
        $this->assertSame(200, $this->doctorAction(CancelLabRequestAction::class, $this->userA, ['labId' => $id], ['reason' => 'No longer needed'])['status']);
        $up = $this->upload($id, null, ['share' => '1']);
        $this->assertSame(201, $up['status'], json_encode($up['body']));
        $this->assertSame('cancelled', $up['body']['data']['request']['status']);
        $res = $this->doctorAction(ReviewLabResultAction::class, $this->userA, ['labId' => $id, 'resultId' => $up['body']['data']['result']['id']], ['outcome' => 'abnormal', 'comment' => 'Please book a follow-up.']);
        $this->assertSame(200, $res['status'], json_encode($res['body']));
        $this->assertSame('cancelled', $res['body']['data']['status']);
        $this->assertTrue($res['body']['data']['abnormal']);
    }

    public function testAResultTheDoctorNoLongerSeesLeavesNeedsReview(): void
    {
        $id = $this->booked();
        $up = $this->upload($id, null, ['share' => '1']);
        $this->assertSame(1, $this->detail($id)['unreviewed_count']);
        $this->assertSame(1, $this->doctorAction(ListDoctorLabRequestsAction::class, $this->userA, [], [], [], 'GET')['body']['data'][0]['unreviewed_count']);

        $c  = $this->container();
        $em = $c->get(EntityManagerInterface::class);
        $c->get(DocumentSharingService::class)->stopSharing($this->patient($em, $this->P), $this->A, LabRequestRules::now());
        $detail = $this->detail($id);
        $this->assertFalse($detail['results'][0]['visible']);
        $this->assertFalse($detail['results'][0]['reviewable']);
        $this->assertNull($detail['results'][0]['document']);
        $this->assertSame(0, $detail['unreviewed_count'], '"Needs review" gone');
        $this->assertFalse($detail['can']['review']);
        $this->assertSame(0, $this->doctorAction(ListDoctorLabRequestsAction::class, $this->userA, [], [], [], 'GET')['body']['data'][0]['unreviewed_count']);
        $this->assertSame($up['body']['data']['result']['id'], $detail['results'][0]['id']);
    }

    public function testAStatOrUrgentResultEmailsTheDoctorAtOnce(): void
    {
        $routine = $this->booked();
        $this->upload($routine, null, ['share' => '1']);
        $this->assertSame(0, $this->emails('lab_result_added'), 'routine: in-app only');
        $this->assertSame(1, $this->countRows("SELECT COUNT(*) FROM staff_notifications WHERE title = 'Result ready for review'"));

        $urgent = $this->booked(['priority' => 'urgent']);
        $this->upload($urgent, null, ['share' => '0']);
        $this->assertSame(1, $this->emails('lab_result_added'), 'urgent: an email at once, shared or not');
        $this->assertSame(1, $this->countRows("SELECT COUNT(*) FROM staff_notifications WHERE title = 'Result ready for review' AND body LIKE ?", ["%They haven't shared it with you."]));
    }

    public function testAConsultationBoundRequestIsEvidenceAndAStandaloneOneIsNot(): void
    {
        $this->sent(['appointment_id' => $this->apPast]);
        $this->sent(['patient_id' => $this->Q, 'clinical' => ['infection_alerts' => []]]);
        $queries = $this->container()->get(ConsultationCompleter::class)->evidenceQueries([$this->apPast, $this->aqPast]);
        $found   = array_map(static fn (array $r): string => strtolower((string) array_values($r)[0]), $queries['lab_request']->getArrayResult());
        $this->assertSame([strtolower($this->apPast)], $found);
    }

    public function testCreatingALegacyLabOrderIsRetired(): void
    {
        $res = $this->doctorAction(CreateLabOrderAction::class, $this->userA, ['id' => $this->apPast], ['tests' => ['FBC']]);
        $this->assertSame(410, $res['status']);
        $this->assertSame(['code' => 'lab_orders_retired', 'message' => 'Lab orders have moved. Use New lab request.'], $res['body']['errors']);
        $this->assertSame(0, $this->countRows('SELECT COUNT(*) FROM lab_orders'));
    }

    /** @return array<string,mixed> */
    private function detail(string $id): array
    {
        return $this->doctorAction(GetDoctorLabRequestAction::class, $this->userA, ['labId' => $id], [], [], 'GET')['body']['data'];
    }
}
