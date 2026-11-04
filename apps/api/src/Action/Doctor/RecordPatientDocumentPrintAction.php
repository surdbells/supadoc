<?php

declare(strict_types=1);

namespace App\Action\Doctor;

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
 * print). Allowed while the doctor owes new terms, like viewing. The record is
 * {@see RecordsDocumentPrint::recordPrint()}, shared with lab results.
 *
 * Body: { view_ref?: "VM-7F3A2C1D" }
 */
final class RecordPatientDocumentPrintAction
{
    use ApiResponse;
    use ResolvesDoctorAppointment;
    use RecordsDocumentPrint;

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

        return $this->recordPrint(
            $response,
            $appointment->getSpecialist(),
            $appointment->getPatient(),
            (string) $args['docId'],
            $appointment->getId(),
            (string) $request->getAttribute('user_id'),
            (array) $request->getParsedBody(),
        );
    }
}
