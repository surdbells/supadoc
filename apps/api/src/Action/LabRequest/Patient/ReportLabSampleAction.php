<?php

declare(strict_types=1);

namespace App\Action\LabRequest\Patient;

use App\Action\LabRequest\LabActionSupport;
use App\Domain\Repository\PatientRepository;
use App\Infrastructure\Lab\LabRequestService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/portal/lab-requests/{labId}/sample — "I've given my sample"
 * (booked → in lab; 409 `status_changed` otherwise). 200 PatientLabRequestDto
 * "Sample recorded".
 */
final class ReportLabSampleAction
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
            $dto = $this->service->sample($patient, (string) $args['labId']);
        } catch (\Throwable $e) {
            return $this->refused($response, $e);
        }

        return $this->noStore($this->success($response, $dto, 'Sample recorded'));
    }
}
