<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Action\Document\StreamsDocument;
use App\Domain\Document\DocumentSharingRules as Rules;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\DocumentAccessGrantRepository;
use App\Domain\Repository\DocumentAccessLogRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Document\DocumentAccessPolicy;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\AuditLogger;
use App\Infrastructure\Service\MedicalDocumentStorage;
use Doctrine\ORM\EntityManagerInterface;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/doctor/appointments/{id}/patient-documents/{docId}/file — open one
 * document the consultation's patient shares with this doctor (spec §3.4):
 *
 *  1. the doctor must own the consultation and it must not be deleted (403);
 *  2. DocumentAccessPolicy decides, bound to THIS consultation's patient — a
 *     document of anyone else, or no longer shared, is 404 `not_shared` and
 *     writes nothing; a shared document whose file is missing is 404 "File not
 *     found" and also writes nothing;
 *  3. the view is recorded BEFORE a byte is streamed, in one transaction: the
 *     audit row (`document.viewed`), the patient's ledger row (`viewed` — every
 *     view) and the grant's access counter;
 *  4. if that record can't be written, nothing is streamed: 503
 *     `view_unavailable` (reported to Sentry).
 */
final class DownloadPatientDocumentAction
{
    use ApiResponse;
    use ResolvesDoctorAppointment;
    use StreamsDocument;

    public function __construct(
        private readonly UserRepository $users,
        private readonly AppointmentRepository $appointments,
        private readonly DocumentAccessPolicy $policy,
        private readonly DocumentAccessGrantRepository $grants,
        private readonly DocumentAccessLogRepository $log,
        private readonly AuditLogger $audit,
        private readonly MedicalDocumentStorage $storage,
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
        // No bytes to hand over: record nothing, so the patient's Activity never
        // says the doctor opened a file they did not receive.
        if (!$this->storage->exists($visible->document)) {
            error_log('[doc-access] file view: no stored file for document ' . $visible->documentId);

            return $this->error($response, 'File not found', 404);
        }

        $conn = $this->em->getConnection();
        try {
            $conn->beginTransaction();
            $this->audit->record(
                $doctor->getName(),
                'doctor',
                'document.viewed',
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
                ],
                (string) $request->getAttribute('user_id'),
            );
            $this->log->append([
                'patient_id'     => $patient->getId(),
                'specialist_id'  => $doctor->getId(),
                'document_id'    => $visible->documentId,
                'grant_id'       => $visible->grantId,
                'appointment_id' => $appointment->getId(),
                'event'          => 'viewed',
                'actor_role'     => 'doctor',
                'details'        => ['via' => $visible->via],
            ], $now);
            $this->grants->touchAccess($visible->grantId, $now);
            $conn->commit();
        } catch (\Throwable $e) {
            if ($conn->isTransactionActive()) {
                $conn->rollBack();
            }

            return $this->unavailable($response, $e);
        }

        return $this->streamDocument($response, $this->storage, $visible->document);
    }

    private function unavailable(ResponseInterface $response, \Throwable $e): ResponseInterface
    {
        if (function_exists('\Sentry\captureException')) {
            \Sentry\captureException($e);
        }
        error_log('[doc-access] file view failed: ' . $e::class . ': ' . $e->getMessage());

        return $this->error($response, 'Could not open the document right now.', 503, ['code' => 'view_unavailable']);
    }
}
