<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Action\Document\StreamsDocument;
use App\Domain\Document\DocumentSharingRules as Rules;
use App\Domain\Entity\Patient;
use App\Domain\Entity\Specialist;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Ramsey\Uuid\Uuid;

/**
 * The view-only file view of a document a patient shares with a doctor (TZ
 * batch §4.2) — shared by the consultation's document route
 * ({@see DownloadPatientDocumentAction}) and a lab result's route
 * (ViewLabResultAction). The using action resolves who and what (and
 * answers its own 403/404) and holds `$policy`, `$grants`, `$log`, `$audit`,
 * `$storage` and `$em`:
 *
 *  - {@see viewerHeaderProblem()}: only the doctor app's view-only viewer may
 *    ask (`X-SD-Viewer: 1`), else 409 `update_required`, nothing recorded;
 *  - {@see viewForDoctor()}: the access policy decides, bound to `$patient`
 *    (404 `not_shared`); a type the viewer can't show is 415 `not_viewable`;
 *    a missing file 404; then — before a byte is streamed, in one
 *    transaction — the audit row `document.viewed` (+ `$extraAudit`), the
 *    patient's ledger row `viewed` and the grant's counter, all carrying the
 *    view reference; 503 `view_unavailable` when that can't be written; the
 *    file is served inline only with `X-SD-View-Ref` / `X-SD-Viewed-At`.
 */
trait ViewsSharedDocument
{
    use StreamsDocument;

    private function viewerHeaderProblem(ServerRequestInterface $request, ResponseInterface $response): ?ResponseInterface
    {
        if ($request->getHeaderLine(DownloadPatientDocumentAction::VIEWER_HEADER) === '1') {
            return null;
        }
        $reload = 'Reload VideoMed to open documents.';

        return $this->error($response, $reload, 409, ['code' => 'update_required', 'message' => $reload]);
    }

    /** @param array<string,mixed> $extraAudit merged into the `document.viewed` metadata */
    private function viewForDoctor(
        ResponseInterface $response,
        Specialist $doctor,
        Patient $patient,
        string $documentId,
        ?string $appointmentId,
        string $userId,
        array $extraAudit = [],
    ): ResponseInterface {
        $now = Rules::now();

        try {
            $visible = $this->policy->visibleDocument($doctor, $patient, $documentId, $now);
        } catch (\Throwable $e) {
            return $this->viewUnavailable($response, $e);
        }
        if ($visible === null) {
            return $this->error($response, 'This document is no longer shared with you.', 404, ['code' => 'not_shared']);
        }
        // A type the viewer can't show is never sent to a doctor (nothing recorded).
        if (!Rules::isViewable($visible->document->getExtension(), $visible->document->getMimeType())) {
            return $this->error($response, "This file type can't be viewed in VideoMed.", 415, ['code' => 'not_viewable']);
        }
        // No bytes to hand over: record nothing, so the patient's Activity never
        // says the doctor opened a file they did not receive.
        if (!$this->storage->exists($visible->document)) {
            error_log('[doc-access] file view: no stored file for document ' . $visible->documentId);

            return $this->error($response, 'File not found', 404);
        }

        // The view reference is made before either row, so both carry it.
        $logId   = Uuid::uuid4()->toString();
        $viewRef = DownloadPatientDocumentAction::viewRef($logId);

        $conn = $this->em->getConnection();
        try {
            $conn->beginTransaction();
            $this->audit->record(
                $doctor->getName(),
                'doctor',
                'document.viewed',
                $appointmentId,
                'medical_document',
                $visible->documentId,
                [
                    'patient_id'    => strtolower($patient->getId()),
                    'patient_name'  => $patient->getFullName(),
                    'specialist_id' => strtolower($doctor->getId()),
                    'doctor'        => $doctor->getName(),
                    'grant_id'      => $visible->grantId,
                    'via'           => $visible->via,
                    'view_ref'      => $viewRef,
                ] + $extraAudit,
                $userId,
            );
            $this->log->append([
                'id'             => $logId,
                'patient_id'     => $patient->getId(),
                'specialist_id'  => $doctor->getId(),
                'document_id'    => $visible->documentId,
                'grant_id'       => $visible->grantId,
                'appointment_id' => $appointmentId,
                'event'          => 'viewed',
                'actor_role'     => 'doctor',
                'details'        => ['via' => $visible->via, 'view_ref' => $viewRef],
            ], $now);
            $this->grants->touchAccess($visible->grantId, $now);
            $conn->commit();
        } catch (\Throwable $e) {
            if ($conn->isTransactionActive()) {
                $conn->rollBack();
            }

            return $this->viewUnavailable($response, $e);
        }

        return $this->streamDocument($response, $this->storage, $visible->document, viewOnly: true, extraHeaders: [
            'X-SD-View-Ref'  => $viewRef,
            'X-SD-Viewed-At' => (string) Rules::iso($now),
        ]);
    }

    private function viewUnavailable(ResponseInterface $response, \Throwable $e): ResponseInterface
    {
        if (function_exists('\Sentry\captureException')) {
            \Sentry\captureException($e);
        }
        error_log('[doc-access] file view failed: ' . $e::class);

        return $this->error($response, 'Could not open the document right now.', 503, ['code' => 'view_unavailable']);
    }
}
