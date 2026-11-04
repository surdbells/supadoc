<?php

declare(strict_types=1);

namespace App\Action\LabRequest\Doctor;

use App\Action\Doctor\ViewsSharedDocument;
use App\Action\LabRequest\LabActionSupport;
use App\Domain\Entity\Patient;
use App\Domain\Lab\LabRequestRules;
use App\Domain\Repository\DocumentAccessGrantRepository;
use App\Domain\Repository\DocumentAccessLogRepository;
use App\Domain\Repository\LabRequestRepository;
use App\Domain\Repository\PatientRepository;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Document\DocumentAccessPolicy;
use App\Infrastructure\Service\AuditLogger;
use App\Infrastructure\Service\MedicalDocumentStorage;
use Doctrine\ORM\EntityManagerInterface;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/doctor/lab-requests/{labId}/results/{resultId}/file — the
 * requesting doctor views one result in the view-only viewer: exactly the
 * contract of the consultation document view ({@see ViewsSharedDocument}):
 * 409 `update_required` without `X-SD-Viewer: 1` (nothing written), 404 for
 * another doctor's request or an unknown result, the access policy (404
 * `not_shared`), 415 `not_viewable`, the view recorded before a byte is
 * streamed (audit `document.viewed` with `lab_request_id`, the patient's
 * ledger, the grant counter — 503 `view_unavailable` when it can't be), served
 * inline with `X-SD-View-Ref` / `X-SD-Viewed-At`.
 */
final class ViewLabResultAction
{
    use LabActionSupport;
    use ViewsSharedDocument;

    public function __construct(
        private readonly UserRepository $users,
        private readonly SpecialistRepository $specialists,
        private readonly PatientRepository $patients,
        private readonly LabRequestRepository $requests,
        private readonly DocumentAccessPolicy $policy,
        private readonly DocumentAccessGrantRepository $grants,
        private readonly DocumentAccessLogRepository $log,
        private readonly AuditLogger $audit,
        private readonly MedicalDocumentStorage $storage,
        private readonly EntityManagerInterface $em,
    ) {
    }

    public function __invoke(ServerRequestInterface $request, ResponseInterface $response, array $args): ResponseInterface
    {
        if (($refused = $this->viewerHeaderProblem($request, $response)) !== null) {
            return $refused;
        }
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

        return $this->viewForDoctor(
            $response,
            $doctor,
            $patient,
            $result->getDocumentId(),
            $r->getAppointmentId(),
            (string) $request->getAttribute('user_id'),
            ['lab_request_id' => $r->getId()],
        );
    }
}
