<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\FollowUpService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/doctor/appointments/{id}/follow-up — the assigned doctor proposes a
 * follow-up of consultation {id} (in progress or completed) at one of their
 * open slots: `{scheduled_at, note?, waive_fee?}`. The follow-up is PROPOSED —
 * it holds the slot until the patient accepts or declines, or it expires — and
 * is priced server-side (the follow-up rules, or free when waived). The note
 * is shown to the patient in the app only. 422s come from {@see FollowUpService::propose()}.
 */
final class ProposeFollowUpAction
{
    use ApiResponse;
    use ResolvesDoctorAppointment;

    public function __construct(
        private readonly UserRepository $users,
        private readonly AppointmentRepository $appointments,
        private readonly FollowUpService $followUps,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
        array $args,
    ): ResponseInterface {
        $parent = $this->doctorAppointment($request, $this->users, $this->appointments, (string) $args['id']);
        if ($parent === null) {
            return $this->error($response, 'You cannot manage this appointment', 403);
        }

        $body     = (array) ($request->getParsedBody() ?? []);
        $proposal = $this->followUps->propose(
            $parent,
            (string) ($body['scheduled_at'] ?? ''),
            isset($body['note']) ? (string) $body['note'] : null,
            filter_var($body['waive_fee'] ?? false, FILTER_VALIDATE_BOOLEAN),
        );

        $patient = $proposal->getPatient()->toArray();

        return $this->created($response, $proposal->toArray() + [
            'patient_name' => trim(((string) $patient['first_name']) . ' ' . ((string) $patient['last_name'])),
        ], 'Follow-up proposed');
    }
}
