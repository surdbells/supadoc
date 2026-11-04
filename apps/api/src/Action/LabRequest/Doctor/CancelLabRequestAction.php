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
 * POST /api/doctor/lab-requests/{labId}/cancel {reason} — the requesting
 * doctor cancels while awaiting consent, booked or in the lab (422 `reason`
 * 3–500, shown to the patient; 409 `status_changed`). The patient is told
 * (in-app + email). 200 LabRequestDto "Request cancelled".
 */
final class CancelLabRequestAction
{
    use LabActionSupport;

    public function __construct(
        private readonly UserRepository $users,
        private readonly SpecialistRepository $specialists,
        private readonly LabRequestService $service,
    ) {
    }

    public function __invoke(ServerRequestInterface $request, ResponseInterface $response, array $args): ResponseInterface
    {
        [$doctor, $denied] = $this->labDoctor($request, $response, $this->users, $this->specialists);
        if ($doctor === null) {
            return $denied;
        }
        try {
            $dto = $this->service->cancel($doctor, (string) $request->getAttribute('user_id'), (string) $args['labId'], $this->body($request));
        } catch (\Throwable $e) {
            return $this->refused($response, $e);
        }

        return $this->noStore($this->success($response, $dto, 'Request cancelled'));
    }
}
