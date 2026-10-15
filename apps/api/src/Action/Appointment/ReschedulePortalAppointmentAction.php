<?php

declare(strict_types=1);

namespace App\Action\Appointment;

use App\Domain\Appointment\AppointmentLifecycle;
use App\Domain\Entity\Appointment;
use App\Domain\Enum\AppointmentStatus;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Settings\BookingSettings;
use App\Infrastructure\Email\EmailTemplates;
use App\Infrastructure\Email\MailService;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\AvailabilityService;
use App\Infrastructure\Service\GuestInvitations;
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
 * RESCHEDULED (the doctor confirms the new time; rescheduled_by `patient`)
 * and both parties are notified — and each guest is emailed the new time with
 * their link. Any open booking (pending, confirmed or rescheduled), only
 * before its start (422 "This consultation has started" after it) — and a
 * confirmed one not inside the late-cancellation window (Booking settings
 * late_cancel_hours > 0: 422 "Too close to the start to move it", so moving
 * it can't dodge the late share), unless the doctor moved it last.
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
        private readonly GuestInvitations $guests,
        private readonly BookingSettings $settings,
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

        if ($appointment->getStatus() === AppointmentStatus::PROPOSED) {
            $instead = 'To take another time, accept this follow-up and choose the new time as you accept it';

            return $this->error($response, $instead, 422, ['status' => $instead]);
        }
        if (!$appointment->getStatus()->isOpenBooking()) {
            return $this->error($response, 'This appointment can no longer be rescheduled', 422, [
                'status' => 'Not reschedulable',
            ]);
        }
        $problem = AppointmentLifecycle::patientRescheduleProblem($appointment, new DateTimeImmutable(), $this->settings->get('late_cancel_hours'));
        if ($problem !== null) {
            return $this->error($response, $problem, 422, ['status' => $problem]);
        }

        // Patients are held to the booking window.
        if ($this->availability->isBeyondHorizon($scheduledAt)) {
            return $this->error($response, 'Validation failed', 422, [
                'scheduled_at' => 'You can book up to ' . $this->availability->horizonDays() . ' days ahead — please pick an earlier time',
            ]);
        }
        // Its own current time doesn't stand in the way of the move.
        if (!$this->availability->isSlotAvailable($appointment->getSpecialist(), $scheduledAt, ignoreAppointmentId: $appointment->getId())) {
            return $this->error($response, 'Validation failed', 422, [
                'scheduled_at' => 'That time is no longer available — please pick another slot',
            ]);
        }

        $appointment->setScheduledAt($scheduledAt);
        $appointment->transitionTo(AppointmentStatus::RESCHEDULED);
        $appointment->setRescheduledBy('patient');
        $this->appointments->save($appointment);

        $this->notify($appointment);
        // Guests get the new time with a fresh copy of their link.
        $this->guests->notifyRescheduled($appointment);

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
