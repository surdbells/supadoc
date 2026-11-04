<?php

declare(strict_types=1);

namespace App\Action\LabRequest\Patient;

use App\Action\LabRequest\LabActionSupport;
use App\Domain\Repository\PatientRepository;
use App\Infrastructure\Lab\LabRequestService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/portal/lab-requests/{labId}/accept {consent_version, agree_tests,
 * agree_pays_lab, agree_disclosure, share_results, lab_name?, lab_date?} — the
 * patient consents (recorded with the wording's version). 409
 * `consent_changed` / `status_changed` / `expired`; 422 `agree`, `lab_name`,
 * `lab_date` (a calendar date from clinic yesterday to `valid_until`). 200
 * PatientLabRequestDto "Request accepted".
 */
final class AcceptLabRequestAction
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
            $dto = $this->service->accept($patient, (string) $args['labId'], $this->body($request));
        } catch (\Throwable $e) {
            return $this->refused($response, $e);
        }

        return $this->noStore($this->success($response, $dto, 'Request accepted'));
    }
}
