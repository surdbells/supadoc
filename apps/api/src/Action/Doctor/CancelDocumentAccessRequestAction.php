<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Domain\Document\DocumentSharingRules as Rules;
use App\Domain\Document\DomainRefusal;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Document\DocumentSharingPresenter;
use App\Infrastructure\Document\DocumentSharingService;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/doctor/appointments/{id}/document-access/request/cancel — the
 * doctor withdraws their pending request to this consultation's patient (no
 * patient notice). 409 `request_not_pending` (+ `errors.status`) when there
 * is none waiting. DoctorAccessRequestDto.
 */
final class CancelDocumentAccessRequestAction
{
    use ApiResponse;
    use ResolvesDoctorAppointment;

    public function __construct(
        private readonly UserRepository $users,
        private readonly AppointmentRepository $appointments,
        private readonly DocumentSharingService $sharing,
    ) {
    }

    public function __invoke(ServerRequestInterface $request, ResponseInterface $response, array $args): ResponseInterface
    {
        $appointment = $this->doctorAppointment($request, $this->users, $this->appointments, strtolower(trim((string) $args['id'])));
        if ($appointment === null || $appointment->isDeleted()) {
            return $this->error($response, 'Consultation not found', 403);
        }
        $now = Rules::now();
        try {
            $row = $this->sharing->cancelRequest($appointment->getSpecialist(), $appointment->getPatient(), $now);
        } catch (DomainRefusal $r) {
            return $this->error($response, $r->getMessage(), $r->status, $r->errors);
        }

        return $this->success($response, DocumentSharingPresenter::doctorRequest($row, $now), 'Request withdrawn');
    }
}
