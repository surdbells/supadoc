<?php

declare(strict_types=1);

namespace App\Action\Appointment;

use App\Domain\Entity\Appointment;
use App\Domain\Enum\AppointmentStatus;
use App\Domain\Repository\AppointmentRepository;
use App\Infrastructure\Email\EmailTemplates;
use App\Infrastructure\Email\MailService;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\AvailabilityService;
use App\Infrastructure\Service\PatientNotifier;
use App\Infrastructure\Service\StaffNotifier;
use DateTimeImmutable;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use App\Domain\Settings\WebUrls;

/**
 * POST /api/portal/appointments/{id}/reschedule — the signed-in patient moves
 * their own booking to a new time. The new slot must be on the specialist's
 * schedule and still open (no double-booking); the appointment goes to
 * RESCHEDULED and both parties are notified.
 */
final class ReschedulePortalAppointmentAction
{
    use ApiResponse;

    public function __construct(
        private readonly AppointmentRepository $appointments,
        private readonly AvailabilityService $availability,
        private readonly MailService $mail,
        private readonly PatientNotifier $patientNotifier,
        private readonly StaffNotifier $staffNotifier,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
        array $args,
    ): ResponseInterface {
        $customerId  = (string) $request->getAttribute('customer_id');
        $appointment = $this->appointments->findForPatient((string) $args['id'], $customerId);
        if ($appointment === null) {
            return $this->error($response, 'Appointment not found', 404);
        }

        $raw = trim((string) (((array) ($request->getParsedBody() ?? []))['scheduled_at'] ?? ''));
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
            return $this->error($response, 'This appointment can no longer be rescheduled', 422, [
                'status' => 'Not reschedulable',
            ]);
        }

        if (!$this->availability->isSlotAvailable($appointment->getSpecialist(), $scheduledAt)) {
            return $this->error($response, 'Validation failed', 422, [
                'scheduled_at' => 'That time is no longer available — please pick another slot',
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
        // Patient in-app + email.
        $this->patientNotifier->appointment($appointment, 'Appointment rescheduled', 'Your appointment has been moved to a new time.');
        try {
            $p    = $appointment->getPatient()->toArray();
            $mail = EmailTemplates::appointmentStatusUpdate(
                $appointment->toArray(),
                (string) ($p['first_name'] ?? ''),
                WebUrls::forPatient($appointment->getPatient()),
            );
            $this->mail->send(
                (string) ($p['email'] ?? ''),
                trim((string) ($p['first_name'] ?? '') . ' ' . (string) ($p['last_name'] ?? '')),
                $mail['subject'],
                $mail['html'],
            );
        } catch (\Throwable) {
            // non-fatal
        }

        // Doctor in-app.
        $appt = $appointment->toArray();
        $this->staffNotifier->notifyDoctor(
            $appointment->getSpecialist()->getId(),
            'appointment',
            'Appointment rescheduled',
            'A patient moved their ' . (string) $appt['type_label'] . ' to a new time.',
            '/schedule',
        );
    }
}
