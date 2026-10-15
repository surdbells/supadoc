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
 * POST /api/doctor/appointments/{id}/follow-up/withdraw — the doctor withdraws
 * their unanswered follow-up proposal {id} (the proposal itself, not the
 * consultation it follows): PROPOSED → CANCELLED, the slot reopens and the
 * patient is told. Idempotent on an already-closed proposal; 422 once the
 * patient has accepted it (cancel the appointment instead). Doctor-owned only.
 */
final class WithdrawFollowUpAction
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
        $proposal = $this->doctorAppointment($request, $this->users, $this->appointments, (string) $args['id']);
        if ($proposal === null) {
            return $this->error($response, 'You cannot manage this appointment', 403);
        }

        $withdrawn = $this->followUps->withdraw($proposal);

        return $this->success(
            $response,
            $proposal->toArray('doctor'),
            $withdrawn ? 'Follow-up withdrawn' : 'Follow-up proposal already closed',
        );
    }
}
