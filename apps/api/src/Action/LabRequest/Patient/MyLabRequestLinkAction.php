<?php

declare(strict_types=1);

namespace App\Action\LabRequest\Patient;

use App\Action\LabRequest\LabActionSupport;
use App\Domain\Entity\LabRequest;
use App\Domain\Lab\LabRequestRules;
use App\Domain\Repository\PatientRepository;
use App\Infrastructure\Lab\LabRequestService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/portal/lab-requests/{labId}/link {download?} — a 15-minute signed
 * URL to the request PDF, once the patient has accepted (booked, in lab,
 * result ready, or expired after accepting); 409 `status_changed` "Accept the
 * request to download it." before. Rate-limited (`lab-link`).
 */
final class MyLabRequestLinkAction
{
    use LabActionSupport;

    public function __construct(
        private readonly PatientRepository $patients,
        private readonly LabRequestService $service,
    ) {
    }

    public function __invoke(ServerRequestInterface $request, ResponseInterface $response, array $args): ResponseInterface
    {
        [$patient, $denied] = $this->labPatient($request, $response, $this->patients);
        if ($patient === null) {
            return $denied;
        }
        try {
            $r = $this->service->patientRequest($patient, (string) $args['labId']);
        } catch (\Throwable $e) {
            return $this->refused($response, $e);
        }
        $status = $r->effectiveStatus(LabRequestRules::now());
        if ($r->getConsentedAt() === null || !in_array($status, [LabRequest::STATUS_BOOKED, LabRequest::STATUS_IN_LAB, LabRequest::STATUS_RESULT_READY, LabRequest::STATUS_EXPIRED], true)) {
            return $this->noStore($this->error($response, 'Accept the request to download it.', 409, ['code' => 'status_changed', 'status' => $status]));
        }
        $download = filter_var($this->body($request)['download'] ?? false, FILTER_VALIDATE_BOOLEAN);

        return $this->noStore($this->success($response, $this->service->issueLink($r, 'patient', $patient->getId(), $download)));
    }
}
