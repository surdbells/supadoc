<?php

declare(strict_types=1);

namespace App\Action\LabRequest\Doctor;

use App\Action\LabRequest\LabActionSupport;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Lab\LabRequestService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/doctor/lab-requests/context?patient_id=&appointment_id= — who the
 * composer is for (LabRequestContextDto): the patient, whether to ask
 * "Pregnant?", the medication / allergy pre-fill and the consultation. 422
 * `appointment_id` for a consultation that isn't this doctor's, is another
 * patient's or hasn't taken place; 422 `not_consulted` otherwise.
 */
final class LabContextAction
{
    use LabActionSupport;

    public function __construct(
        private readonly UserRepository $users,
        private readonly SpecialistRepository $specialists,
        private readonly LabRequestService $service,
    ) {
    }

    public function __invoke(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        [$doctor, $denied] = $this->labDoctor($request, $response, $this->users, $this->specialists);
        if ($doctor === null) {
            return $denied;
        }
        $query       = $request->getQueryParams();
        $appointment = is_string($query['appointment_id'] ?? null) && trim($query['appointment_id']) !== '' ? (string) $query['appointment_id'] : null;
        try {
            $context = $this->service->context($doctor, (string) ($query['patient_id'] ?? ''), $appointment);
        } catch (\Throwable $e) {
            return $this->refused($response, $e);
        }

        return $this->noStore($this->success($response, $context));
    }
}
