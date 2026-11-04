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
use Ramsey\Uuid\Uuid;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/doctor/appointments/{id}/patient-documents/{docId}/file — view one
 * document the consultation's patient shares with this doctor, in the doctor
 * app's view-only viewer (it can show and print, never download):
 *
 *  0. only the viewer may ask (`X-SD-Viewer: 1`); an old doctor tab that would
 *     open the file in the browser's own viewer (which has a download button)
 *     gets 409 `update_required` and nothing is recorded;
 *  1. the doctor must own the consultation and it must not be deleted (403);
 *  2. DocumentAccessPolicy decides, bound to THIS consultation's patient — a
 *     document of anyone else, or no longer shared, is 404 `not_shared` and
 *     writes nothing; a shared document whose file is missing is 404 "File not
 *     found" and also writes nothing;
 *  2b. a type the viewer can't show (Word, DICOM, .mov…) is 415 `not_viewable`:
 *     nothing is streamed or recorded;
 *  3. the view is recorded BEFORE a byte is streamed, in one transaction: the
 *     audit row (`document.viewed`), the patient's ledger row (`viewed` — every
 *     view) and the grant's access counter. Both carry the view reference
 *     "VM-" + the first 8 hex digits of the ledger row's id, which the viewer
 *     watermarks and a print cites;
 *  4. if that record can't be written, nothing is streamed: 503
 *     `view_unavailable` (reported to Sentry);
 *  5. the file is served inline only, with its extension's fixed type, no
 *     caching and a sandboxing CSP, plus `X-SD-View-Ref` / `X-SD-Viewed-At`.
 */
final class DownloadPatientDocumentAction
{
    use ApiResponse;
    use ResolvesDoctorAppointment;
    use StreamsDocument;

    /** The header only the doctor app's view-only viewer sends. */
    public const VIEWER_HEADER = 'X-SD-Viewer';

    private const RELOAD = 'Reload VideoMed to open documents.';

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
        if ($request->getHeaderLine(self::VIEWER_HEADER) !== '1') {
            return $this->error($response, self::RELOAD, 409, ['code' => 'update_required', 'message' => self::RELOAD]);
        }
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
        $viewRef = self::viewRef($logId);

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
                    'view_ref'      => $viewRef,
                ],
                (string) $request->getAttribute('user_id'),
            );
            $this->log->append([
                'id'             => $logId,
                'patient_id'     => $patient->getId(),
                'specialist_id'  => $doctor->getId(),
                'document_id'    => $visible->documentId,
                'grant_id'       => $visible->grantId,
                'appointment_id' => $appointment->getId(),
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

            return $this->unavailable($response, $e);
        }

        return $this->streamDocument($response, $this->storage, $visible->document, viewOnly: true, extraHeaders: [
            'X-SD-View-Ref'  => $viewRef,
            'X-SD-Viewed-At' => (string) Rules::iso($now),
        ]);
    }

    /** "VM-" + the first 8 hex digits of a ledger row id, upper-case. */
    public static function viewRef(string $logId): string
    {
        return 'VM-' . strtoupper(substr(str_replace('-', '', $logId), 0, 8));
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
