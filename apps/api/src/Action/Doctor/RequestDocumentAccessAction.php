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
 * POST /api/doctor/appointments/{id}/document-access/request `{ message? }` —
 * ask the consultation's patient to share documents (an extension while a
 * whole-folder share ends within 48 hours). The patient gets an in-app notice
 * and an email naming the doctor only; the note is shown in the app alone.
 * 201 DoctorAccessRequestDto. 403 not the doctor's (or deleted); 422
 * `appointment_not_eligible` / `doctor_unavailable` / `message`; 409
 * `request_pending` / `request_cooldown` / `request_limit` (+ `available_at`)
 * / `has_full_access` / `request_blocked`; 503 `sharing_unavailable`.
 */
final class RequestDocumentAccessAction
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
        $body    = $request->getParsedBody();
        $message = is_array($body) ? ($body['message'] ?? null) : null;
        if ($message !== null && !is_string($message)) {
            return $this->error($response, 'Write the reason as text.', 422, ['message' => 'Write the reason as text.']);
        }
        $now = Rules::now();
        try {
            $row = $this->sharing->requestAccess($appointment->getSpecialist(), $appointment, (string) $request->getAttribute('user_id'), $message, $now);
        } catch (DomainRefusal $r) {
            return $this->error($response, $r->getMessage(), $r->status, $r->errors);
        }

        return $this->created($response, DocumentSharingPresenter::doctorRequest($row, $now), 'Request sent');
    }
}
