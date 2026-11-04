<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Domain\Document\DocumentSharingRules as Rules;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\DocumentAccessLogRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Document\DocumentAccessPolicy;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\AuditLogger;
use Doctrine\ORM\EntityManagerInterface;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/doctor/appointments/{id}/patient-documents/{docId}/printed — the
 * doctor's viewer is about to print a document (a watermarked raster of its
 * pages); record it like a view, before the print dialog opens, so the patient
 * sees it in their Activity ("sent … to print").
 *
 * Same checks as viewing: the doctor owns the consultation (403) and the
 * document is still shared with them (404 `not_shared`). `view_ref` (the
 * reference of the view being printed, "VM-XXXXXXXX") is kept only when it
 * names a real `viewed` row of this doctor and this document — otherwise it is
 * stored as null; a bad or missing one never refuses the print. Then one
 * transaction: the audit row `document.printed` and the ledger row `printed`.
 * 503 `view_unavailable` when that can't be written (the viewer then doesn't
 * print). Allowed while the doctor owes new terms, like viewing.
 *
 * Body: { view_ref?: "VM-7F3A2C1D" }
 */
final class RecordPatientDocumentPrintAction
{
    use ApiResponse;
    use ResolvesDoctorAppointment;

    public function __construct(
        private readonly UserRepository $users,
        private readonly AppointmentRepository $appointments,
        private readonly DocumentAccessPolicy $policy,
        private readonly DocumentAccessLogRepository $log,
        private readonly AuditLogger $audit,
        private readonly EntityManagerInterface $em,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
        array $args,
    ): ResponseInterface {
        $appointment = $this->doctorAppointment($request, $this->users, $this->appointments, strtolower(trim((string) $args['id'])));
        if ($appointment === null || $appointment->isDeleted()) {
            return $this->error($response, 'Consultation not found', 403);
        }
        $doctor  = $appointment->getSpecialist();
        $patient = $appointment->getPatient();
        $now     = Rules::now();

        try {
            $visible = $this->policy->visibleDocument($doctor, $patient, (string) $args['docId'], $now);
        } catch (\Throwable $e) {
            return $this->unavailable($response, $e);
        }
        if ($visible === null) {
            return $this->error($response, 'This document is no longer shared with you.', 404, ['code' => 'not_shared']);
        }

        $body    = (array) $request->getParsedBody();
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
                    $appointment->getId(),
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
                    ],
                    (string) $request->getAttribute('user_id'),
                );
                $this->log->append([
                    'patient_id'     => $patient->getId(),
                    'specialist_id'  => $doctor->getId(),
                    'document_id'    => $visible->documentId,
                    'grant_id'       => $visible->grantId,
                    'appointment_id' => $appointment->getId(),
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
            return $this->unavailable($response, $e);
        }

        return $this->success($response, ['recorded' => true], 'Recorded');
    }

    private function unavailable(ResponseInterface $response, \Throwable $e): ResponseInterface
    {
        if (function_exists('\Sentry\captureException')) {
            \Sentry\captureException($e);
        }
        error_log('[doc-access] print record failed: ' . $e::class);

        return $this->error($response, 'Could not record the print right now.', 503, ['code' => 'view_unavailable']);
    }
}
