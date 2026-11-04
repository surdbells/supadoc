<?php

declare(strict_types=1);

namespace App\Action\LabRequest\Patient;

use App\Action\LabRequest\LabActionSupport;
use App\Domain\Repository\PatientRepository;
use App\Infrastructure\Lab\LabRequestService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/portal/lab-requests/{labId} — the patient's view
 * (PatientLabRequestDto): what's requested and how to prepare, the consent
 * statements, their results with who can see them, and the doctor's notes —
 * never a review outcome or the clinical flags.
 */
final class GetMyLabRequestAction
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
            $dto = $this->service->patientDetail($patient, $this->service->patientRequest($patient, (string) $args['labId']));
        } catch (\Throwable $e) {
            return $this->refused($response, $e);
        }

        return $this->noStore($this->success($response, $dto));
    }
}
