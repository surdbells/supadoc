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
use DateTimeImmutable;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/doctor/appointments/{id}/reschedule — the assigned doctor moves a
 * booking to a new time. Sets the new time, marks it RESCHEDULED and emails the
 * patient. Doctor-owned only.
 */
final class RescheduleDoctorAppointmentAction
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

        $body = (array) $request->getParsedBody();
        $raw  = trim((string) ($body['scheduled_at'] ?? ''));
        if ($raw === '') {
            return $this->error($response, 'Validation failed', 422, ['scheduled_at' => 'A new date and time is required']);
        }
        try {
            $scheduledAt = new DateTimeImmutable($raw);
        } catch (\Throwable) {
            return $this->error($response, 'Validation failed', 422, ['scheduled_at' => 'Invalid date/time']);
        }
        if ($scheduledAt <= new DateTimeImmutable()) {
            return $this->error($response, 'Validation failed', 422, ['scheduled_at' => 'Choose a time in the future']);
        }

        if (!$appointment->getStatus()->canTransitionTo(AppointmentStatus::RESCHEDULED)) {
            return $this->error($response, 'This appointment cannot be rescheduled', 422, [
                'status' => 'Not reschedulable',
            ]);
        }

        $appointment->setScheduledAt($scheduledAt);
        $appointment->transitionTo(AppointmentStatus::RESCHEDULED);
        $this->appointments->save($appointment);

        $this->notify($appointment);

        return $this->success($response, $appointment->toArray(), 'Appointment rescheduled');
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
            // logged inside MailService; the reschedule already succeeded.
        }
    }
}
