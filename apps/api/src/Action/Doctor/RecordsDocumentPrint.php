<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Domain\Document\DocumentSharingRules as Rules;
use App\Domain\Entity\Patient;
use App\Domain\Entity\Specialist;
use Psr\Http\Message\ResponseInterface;

/**
 * Record a print of a document a doctor is viewing (TZ batch §4.2) — shared
 * by the consultation's document route ({@see RecordPatientDocumentPrintAction})
 * and a lab result's route (RecordLabResultPrintAction). The using action
 * resolves who and what and holds `$policy`, `$log`, `$audit` and `$em`.
 *
 * Same check as viewing: the document is still shared with this doctor (404
 * `not_shared`). `view_ref` ("VM-XXXXXXXX") is kept only when it names a real
 * `viewed` row of this doctor and this document — else stored as null; it
 * never refuses the print. Then one transaction: the audit row
 * `document.printed` (+ `$extraAudit`) and the ledger row `printed`. 503
 * `view_unavailable` when that can't be written (the viewer then doesn't print).
 */
trait RecordsDocumentPrint
{
    /**
     * @param array<string,mixed> $body       { view_ref?: string }
     * @param array<string,mixed> $extraAudit merged into the `document.printed` metadata
     */
    private function recordPrint(
        ResponseInterface $response,
        Specialist $doctor,
        Patient $patient,
        string $documentId,
        ?string $appointmentId,
        string $userId,
        array $body,
        array $extraAudit = [],
    ): ResponseInterface {
        $now = Rules::now();

        try {
            $visible = $this->policy->visibleDocument($doctor, $patient, $documentId, $now);
        } catch (\Throwable $e) {
            return $this->printUnavailable($response, $e);
        }
        if ($visible === null) {
            return $this->error($response, 'This document is no longer shared with you.', 404, ['code' => 'not_shared']);
        }

        $raw     = $body['view_ref'] ?? null;
        $viewRef = null;
        try {
            if (is_string($raw) && preg_match('/^VM-[0-9A-F]{8}$/', $raw) === 1
                && $this->log->hasViewRef($doctor->getId(), $visible->documentId, $raw)
            ) {
                $viewRef = $raw;
            }

            $conn = $this->em->getConnection();
            $conn->beginTransaction();
            try {
                $this->audit->record(
                    $doctor->getName(),
                    'doctor',
                    'document.printed',
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
                    'patient_id'     => $patient->getId(),
                    'specialist_id'  => $doctor->getId(),
                    'document_id'    => $visible->documentId,
                    'grant_id'       => $visible->grantId,
                    'appointment_id' => $appointmentId,
                    'event'          => 'printed',
                    'actor_role'     => 'doctor',
                    'details'        => ['via' => $visible->via, 'view_ref' => $viewRef],
                ], $now);
                $conn->commit();
            } catch (\Throwable $e) {
                if ($conn->isTransactionActive()) {
                    $conn->rollBack();
                }
                throw $e;
            }
        } catch (\Throwable $e) {
            return $this->printUnavailable($response, $e);
        }

        return $this->success($response, ['recorded' => true], 'Recorded');
    }

    private function printUnavailable(ResponseInterface $response, \Throwable $e): ResponseInterface
    {
        if (function_exists('\Sentry\captureException')) {
            \Sentry\captureException($e);
        }
        error_log('[doc-access] print record failed: ' . $e::class);

        return $this->error($response, 'Could not record the print right now.', 503, ['code' => 'view_unavailable']);
    }
}
