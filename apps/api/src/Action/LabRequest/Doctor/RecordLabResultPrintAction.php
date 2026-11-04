<?php

declare(strict_types=1);

namespace App\Action\LabRequest\Doctor;

use App\Action\Doctor\RecordsDocumentPrint;
use App\Action\LabRequest\LabActionSupport;
use App\Domain\Entity\Patient;
use App\Domain\Lab\LabRequestRules;
use App\Domain\Repository\DocumentAccessLogRepository;
use App\Domain\Repository\LabRequestRepository;
use App\Domain\Repository\PatientRepository;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Document\DocumentAccessPolicy;
use App\Infrastructure\Service\AuditLogger;
use Doctrine\ORM\EntityManagerInterface;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/doctor/lab-requests/{labId}/results/{resultId}/printed {view_ref?}
 * — record a print of a result the doctor is viewing, as the consultation
 * document print ({@see RecordsDocumentPrint}): 404 for another doctor's
 * request, 404 `not_shared`; `view_ref` kept only when it names this doctor's
 * real view of this document; audit `document.printed` (with
 * `lab_request_id`) + ledger `printed`; 503 `view_unavailable`. Allowed while
 * the doctor owes new terms.
 */
final class RecordLabResultPrintAction
{
    use LabActionSupport;
    use RecordsDocumentPrint;

    public function __construct(
        private readonly UserRepository $users,
        private readonly SpecialistRepository $specialists,
        private readonly PatientRepository $patients,
        private readonly LabRequestRepository $requests,
        private readonly DocumentAccessPolicy $policy,
        private readonly DocumentAccessLogRepository $log,
        private readonly AuditLogger $audit,
        private readonly EntityManagerInterface $em,
    ) {
    }

    public function __invoke(ServerRequestInterface $request, ResponseInterface $response, array $args): ResponseInterface
    {
        [$doctor, $denied] = $this->labDoctor($request, $response, $this->users, $this->specialists);
        if ($doctor === null) {
            return $denied;
        }
        $r       = $this->requests->findForSpecialist((string) $args['labId'], $doctor->getId());
        $result  = $r?->result((string) $args['resultId']);
        $patient = $r !== null ? $this->patients->find($r->getPatientId()) : null;
        if ($r === null || $result === null || !$patient instanceof Patient) {
            return $this->noStore($this->error($response, LabRequestRules::NOT_FOUND, 404));
        }

        return $this->recordPrint(
            $response,
            $doctor,
            $patient,
            $result->getDocumentId(),
            $r->getAppointmentId(),
            (string) $request->getAttribute('user_id'),
            $this->body($request),
            ['lab_request_id' => $r->getId()],
        );
    }
}
