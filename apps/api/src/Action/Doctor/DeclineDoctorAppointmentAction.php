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
use App\Infrastructure\Service\AppointmentPaymentService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/doctor/appointments/{id}/decline — the assigned doctor declines a
 * booking. Cancels it, refunds a paid booking to the patient's wallet, and
 * emails the patient. Doctor-owned only.
 */
final class DeclineDoctorAppointmentAction
{
    use ApiResponse;
    use ResolvesDoctorAppointment;

    public function __construct(
        private readonly UserRepository $users,
        private readonly AppointmentRepository $appointments,
        private readonly AppointmentPaymentService $payments,
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
        if ($current === AppointmentStatus::CANCELLED) {
            return $this->success($response, $appointment->toArray(), 'Appointment already cancelled');
        }
        if (!$current->canTransitionTo(AppointmentStatus::CANCELLED)) {
            return $this->error($response, 'This appointment can no longer be declined', 422, [
                'status' => 'Not declinable',
            ]);
        }

        $appointment->transitionTo(AppointmentStatus::CANCELLED);
        $this->payments->refundForCancellation($appointment);
        $this->appointments->save($appointment);

        $this->notify($appointment);

        return $this->success($response, $appointment->toArray(), 'Appointment declined');
    }

    private function notify(Appointment $appointment): void
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
            // logged inside MailService; the decline already succeeded.
        }
    }
}
