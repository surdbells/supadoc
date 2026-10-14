<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Domain\Entity\Appointment;
use App\Domain\Enum\AppointmentStatus;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\CallPresence;
use App\Infrastructure\Service\ConsultationCompleter;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/doctor/appointments/{id}/complete — the assigned doctor ends the
 * consultation (the cockpit's End, or "Mark consultation completed" on the
 * appointment page). Moves it CONFIRMED → COMPLETED so it moves to both
 * histories, can be reviewed and counts towards earnings; audits it and tells
 * the patient. Idempotent: an already-completed visit answers 200 and nothing
 * is sent twice. A visit that hasn't started (before its time, and the doctor
 * isn't in the call) can't be completed.
 */
final class CompleteDoctorAppointmentAction
{
    use ApiResponse;
    use ResolvesDoctorAppointment;

    public function __construct(
        private readonly UserRepository $users,
        private readonly AppointmentRepository $appointments,
        private readonly CallPresence $presence,
        private readonly ConsultationCompleter $completer,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
        array $args,
    ): ResponseInterface {
        $appointment = $this->doctorAppointment($request, $this->users, $this->appointments, (string) $args['id']);
        if ($appointment === null) {
            return $this->error($response, 'You cannot manage this appointment', 403);
        }

        if ($appointment->getStatus() === AppointmentStatus::COMPLETED) {
            return $this->success($response, $appointment->toArray(), 'Consultation already completed');
        }
        $problem = ConsultationCompleter::completionProblem(
            $appointment->getStatus(),
            $appointment->getScheduledAt(),
            fn (): bool => $this->doctorInCall($appointment),
        );
        if ($problem !== null) {
            return $this->error($response, $problem, 422, [
                $appointment->getStatus() === AppointmentStatus::CONFIRMED ? 'scheduled_at' : 'status' => $problem,
            ]);
        }

        if (!$this->completer->complete($appointment, $appointment->getSpecialist()->getName(), 'doctor', 'appointment.completed')) {
            // Closed by someone else a moment ago (another tab, the cron, the
            // back office) — `$appointment` now holds the stored status.
            if ($appointment->getStatus() === AppointmentStatus::COMPLETED) {
                return $this->success($response, $appointment->toArray(), 'Consultation already completed');
            }

            $gone = 'This appointment can no longer be marked completed';

            return $this->error($response, $gone, 422, ['status' => $gone]);
        }

        return $this->success($response, $appointment->toArray(), 'Consultation completed');
    }

    /** The doctor's call screen is sending heartbeats for this consultation right now. */
    private function doctorInCall(Appointment $appointment): bool
    {
        $live = $this->presence->forSpecialist($appointment->getSpecialist()->getId());

        return ($live[$appointment->getId()]['doctor'] ?? false) === true;
    }
}
