<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Domain\Entity\Appointment;
use App\Domain\Enum\AppointmentStatus;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Email\EmailTemplates;
use App\Infrastructure\Email\MailService;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/doctor/appointments/{id}/confirm — the assigned doctor confirms a
 * pending booking. Moves it PENDING/RESCHEDULED → CONFIRMED and emails the
 * patient. A doctor can only ever confirm their own consultations.
 */
final class ConfirmDoctorAppointmentAction
{
    use ApiResponse;
    use ResolvesDoctorAppointment;

    public function __construct(
        private readonly UserRepository $users,
        private readonly AppointmentRepository $appointments,
        private readonly MailService $mail,
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

        $current = $appointment->getStatus();
        if ($current === AppointmentStatus::CONFIRMED) {
            return $this->success($response, $appointment->toArray(), 'Appointment already confirmed');
        }
        if (!$current->canTransitionTo(AppointmentStatus::CONFIRMED)) {
            return $this->error($response, 'This appointment cannot be confirmed', 422, [
                'status' => 'Not confirmable',
            ]);
        }

        $appointment->transitionTo(AppointmentStatus::CONFIRMED);
        $this->appointments->save($appointment);

        $this->notifyConfirmed($appointment);

        return $this->success($response, $appointment->toArray(), 'Appointment confirmed');
    }

    /** Fire-and-forget confirmation email to the patient. */
    private function notifyConfirmed(Appointment $appointment): void
    {
        try {
            $p    = $appointment->getPatient()->toArray();
            $mail = EmailTemplates::appointmentStatusUpdate(
                $appointment->toArray(),
                (string) ($p['first_name'] ?? ''),
                $_ENV['APP_WEB_URL'] ?? 'http://localhost:4201',
            );
            $this->mail->send(
                (string) ($p['email'] ?? ''),
                trim((string) ($p['first_name'] ?? '') . ' ' . (string) ($p['last_name'] ?? '')),
                $mail['subject'],
                $mail['html'],
            );
        } catch (\Throwable) {
            // logged inside MailService; the confirmation already succeeded.
        }
    }
}
