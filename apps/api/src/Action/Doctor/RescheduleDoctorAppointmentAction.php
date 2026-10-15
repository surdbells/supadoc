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
use App\Infrastructure\Service\AvailabilityService;
use App\Infrastructure\Service\GuestInvitations;
use App\Infrastructure\Service\PatientNotifier;
use DateTimeImmutable;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use App\Domain\Settings\WebUrls;

/**
 * POST /api/doctor/appointments/{id}/reschedule — the assigned doctor moves a
 * booking to a new time. The new time must be one of the doctor's open slots
 * (the patient booking rules — {@see AvailabilityService::isSlotAvailable()}).
 * Sets the new time, marks it RESCHEDULED and emails the patient, and each guest
 * the new time with their link. Doctor-owned only.
 */
final class RescheduleDoctorAppointmentAction
{
    use ApiResponse;
    use ResolvesDoctorAppointment;

    public function __construct(
        private readonly UserRepository $users,
        private readonly AppointmentRepository $appointments,
        private readonly AvailabilityService $availability,
        private readonly MailService $mail,
        private readonly PatientNotifier $patientNotifier,
        private readonly GuestInvitations $guests,
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

        if ($appointment->getStatus() === AppointmentStatus::PROPOSED) {
            $instead = 'Withdraw this follow-up proposal and propose the new time instead';

            return $this->error($response, $instead, 422, ['status' => $instead]);
        }
        if (!$appointment->getStatus()->canTransitionTo(AppointmentStatus::RESCHEDULED)) {
            return $this->error($response, 'This appointment cannot be rescheduled', 422, [
                'status' => 'Not reschedulable',
            ]);
        }

        // The same guard as a patient booking: lead time, on the schedule, not
        // blocked, not already taken (by anything but this appointment itself)
        // — but not held to the patient booking window.
        if (!$this->availability->isSlotAvailable($appointment->getSpecialist(), $scheduledAt, false, ignoreAppointmentId: $appointment->getId())) {
            return $this->error($response, 'Validation failed', 422, [
                'scheduled_at' => 'That time is not open on your schedule — choose an open slot at least ' . $this->availability->leadLabel() . ' ahead (not blocked or already booked)',
            ]);
        }

        $appointment->setScheduledAt($scheduledAt);
        $appointment->transitionTo(AppointmentStatus::RESCHEDULED);
        $this->appointments->save($appointment);

        $this->notify($appointment);
        $this->patientNotifier->appointment($appointment, 'Appointment rescheduled', 'Your appointment has been moved to a new time.');
        // Guests get the new time with a fresh copy of their link.
        $this->guests->notifyRescheduled($appointment);

        return $this->success($response, $appointment->toArray(), 'Appointment rescheduled');
    }

    private function notify(Appointment $appointment): void
    {
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
            // logged inside MailService; the reschedule already succeeded.
        }
    }
}
