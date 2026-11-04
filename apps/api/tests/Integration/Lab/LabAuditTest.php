<?php

declare(strict_types=1);

namespace App\Tests\Integration\Lab;

use App\Action\LabRequest\Admin\CorrectLabRequestStatusAction;
use App\Action\LabRequest\Doctor\CancelLabRequestAction;
use App\Action\LabRequest\Doctor\DoctorLabRequestLinkAction;
use App\Action\LabRequest\Doctor\ReviewLabResultAction;
use App\Action\LabRequest\Patient\DeclineLabRequestAction;
use App\Action\LabRequest\Patient\ReportLabSampleAction;
use App\Action\LabRequest\Public\LabRequestFileAction;
use App\Domain\Document\DocumentSharingRules as Rules;
use App\Domain\Lab\LabRequestRules;
use App\Infrastructure\Lab\LabRequestSweeper;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response;

/**
 * The audit trail of lab requests (lab spec §1.10): every row of a whole
 * lifecycle carries only allowlisted metadata (and the patient's id, for
 * the back office's link) — never a test, the clinical question, a reason,
 * a review comment or outcome.
 */
final class LabAuditTest extends LabTestCase
{
    /** action => the metadata keys it may carry */
    private const ALLOWLIST = [
        'lab_request.sent'             => ['number', 'items', 'priority', 'patient_id'],
        'signature.used'               => ['number', 'mode', 'patient_id'],
        'lab_request.accepted'         => ['number', 'consent_version', 'share_results', 'patient_id'],
        'lab_request.declined'         => ['number', 'reason_given', 'patient_id'],
        'lab_request.sample_given'     => ['number', 'patient_id'],
        'lab_result.added'             => ['number', 'result_id', 'share_outcome', 'patient_id'],
        'lab_result.reviewed'          => ['number', 'result_id', 'changed', 'patient_id'],
        'lab_request.cancelled'        => ['number', 'patient_id'],
        'lab_request.expired'          => ['number', 'patient_id'],
        'lab_request.status_corrected' => ['number', 'from', 'to', 'reason_given', 'patient_id'],
        'lab_result.review_escalated'  => ['number', 'result_id', 'patient_id'],
        'lab_request.viewed'           => ['number', 'status', 'patient_id'],
        'lab_request.downloaded'       => ['number', 'status', 'patient_id'],
    ];

    public function testAWholeLifecycleAuditsOnlyAllowlistedMetadata(): void
    {
        $secret   = ['Suspected iron-deficiency anaemia', 'Full Blood Count', 'Troponin', 'busy that week', 'wrong patient', 'phoned support', 'Low haemoglobin', 'abnormal'];
        $reviewed = $this->booked(['items' => [['code' => 'FBC'], ['code' => 'TROPI']]]);
        $this->patientAction(ReportLabSampleAction::class, $this->P, [], ['labId' => $reviewed]);
        $result = $this->upload($reviewed)['body']['data']['result']['id'];
        $this->doctorAction(ReviewLabResultAction::class, $this->userA, ['labId' => $reviewed, 'resultId' => $result], ['outcome' => 'abnormal', 'comment' => 'Low haemoglobin. Please book a follow-up.']);
        $this->conn()->executeStatement('UPDATE lab_request_results SET uploaded_at = ?, reviewed_at = NULL WHERE id = ?', [Rules::sql(LabRequestRules::now()->modify('-8 days')), $result]);

        $declined = $this->sent();
        $this->patientAction(DeclineLabRequestAction::class, $this->P, ['reason' => "I'm busy that week"], ['labId' => $declined]);
        $this->staffAction(CorrectLabRequestStatusAction::class, $this->staffLabs, ['labs.manage'], ['labId' => $declined], ['status' => 'awaiting_consent', 'reason' => 'Patient phoned support']);
        $this->doctorAction(CancelLabRequestAction::class, $this->userA, ['labId' => $declined], ['reason' => 'Ordered for the wrong patient']);

        $expired = $this->sent();
        $this->conn()->executeStatement('UPDATE lab_requests SET expires_at = ? WHERE id = ?', [Rules::sql(LabRequestRules::now()->modify('-1 hour')), $expired]);
        $this->container()->get(LabRequestSweeper::class)->run();

        $link = $this->doctorAction(DoctorLabRequestLinkAction::class, $this->userA, ['labId' => $reviewed])['body']['data']['url'];
        parse_str((string) parse_url($link, PHP_URL_QUERY), $q);
        $this->container()->get(LabRequestFileAction::class)((new ServerRequestFactory())->createServerRequest('GET', '/api/test')->withQueryParams(['token' => $q['token']]), new Response());

        $rows = $this->conn()->fetchAllAssociative("SELECT action, CAST(metadata AS TEXT) AS metadata FROM audit_events WHERE resource_type IN ('lab_request', 'lab_result')");
        $seen = [];
        foreach ($rows as $row) {
            $this->assertArrayHasKey($row['action'], self::ALLOWLIST, 'an unexpected lab audit action: ' . $row['action']);
            $meta = (array) json_decode((string) $row['metadata'], true);
            $this->assertSame([], array_values(array_diff(array_keys($meta), self::ALLOWLIST[$row['action']])), $row['action'] . ': ' . $row['metadata']);
            $this->assertSame($this->P, $meta['patient_id'] ?? null, $row['action']);
            foreach ($secret as $word) {
                $this->assertStringNotContainsStringIgnoringCase($word, (string) $row['metadata'], $row['action']);
            }
            $seen[$row['action']] = true;
        }
        foreach (['lab_request.sent', 'signature.used', 'lab_request.accepted', 'lab_request.declined', 'lab_request.sample_given', 'lab_result.added',
            'lab_result.reviewed', 'lab_request.cancelled', 'lab_request.expired', 'lab_request.status_corrected', 'lab_result.review_escalated', 'lab_request.viewed'] as $action) {
            $this->assertArrayHasKey($action, $seen, $action . ' was recorded');
        }
    }
}
