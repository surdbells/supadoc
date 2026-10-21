<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Domain\Appointment\AppointmentLifecycle;
use App\Domain\Document\DocumentSharingRules;
use App\Domain\Entity\Appointment;
use App\Infrastructure\Document\DocumentAccessNotifier;
use App\Infrastructure\Document\DocumentSharingService;
use App\Domain\Enum\AppointmentStatus;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\UserRepository;
use App\Domain\Settings\ProcessClock;
use App\Infrastructure\Email\EmailTemplates;
use App\Infrastructure\Email\MailService;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\AvailabilityService;
use App\Infrastructure\Service\GuestInvitations;
use App\Infrastructure\Service\PatientNotifier;
use App\Infrastructure\Service\SlotLock;
use DateTimeImmutable;
use Doctrine\DBAL\Exception\UniqueConstraintViolationException;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use App\Domain\Settings\WebUrls;

/**
 * POST /api/doctor/appointments/{id}/reschedule — the assigned doctor moves a
 * booking to a new time. The new time must be one of the doctor's open slots
 * (the patient booking rules — {@see AvailabilityService::isSlotAvailable()}).
 * Sets the new time and CONFIRMS it — the doctor chose it, so there is nothing
 * left to confirm (rescheduled_by `doctor`); the patient is told and can still
 * cancel (in full, before the start) or move it if it doesn't suit. Each guest
 * is emailed the new time with their link. Any open booking (pending,
 * confirmed, rescheduled), until AppointmentLifecycle::CONFIRM_GRACE_MINUTES
 * after its slot ended. Doctor-owned only.
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
        private readonly SlotLock $slots,
        private readonly DocumentSharingService $sharing,
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
            $scheduledAt = ProcessClock::normalize(new DateTimeImmutable($raw));
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
        if (!$appointment->getStatus()->isOpenBooking()) {
            return $this->error($response, 'This appointment cannot be rescheduled', 422, [
                'status' => 'Not reschedulable',
            ]);
        }
        if (($ended = AppointmentLifecycle::doctorRescheduleProblem($appointment, new DateTimeImmutable())) !== null) {
            return $this->error($response, $ended, 422, ['status' => $ended]);
        }

        // The same guard as a patient booking: lead time, on the schedule, not
        // blocked, not already taken (by anything but this appointment itself)
        // — but not held to the patient booking window.
        if (!$this->availability->isSlotAvailable($appointment->getSpecialist(), $scheduledAt, false, ignoreAppointmentId: $appointment->getId())) {
            return $this->error($response, 'Validation failed', 422, [
                'scheduled_at' => 'That time is not open on your schedule — choose an open slot at least ' . $this->availability->leadLabel() . ' ahead (not blocked or already booked)',
            ]);
        }

        // Taken under the doctor's slot lock, re-checked there (a patient may
        // have booked that time a moment ago). The appointment itself is then
        // locked and re-read, and the checks above run again on what it is NOW:
        // a cancellation (and its refund) that committed while this request
        // waited must not be confirmed back to life. (Lock order: the doctor's
        // slot, then the row — as every slot-taking path.)
        $sharesMoved = [];
        try {
            $moved = $this->appointments->transactional(function () use ($appointment, $scheduledAt, &$sharesMoved): bool|string {
                $this->slots->lockDoctor($appointment->getSpecialist()->getId());
                $this->appointments->lockAndRefresh($appointment);
                if ($appointment->isDeleted() || !$appointment->getStatus()->isOpenBooking()) {
                    return 'This appointment changed meanwhile and can no longer be rescheduled — please reload it';
                }
                if (($ended = AppointmentLifecycle::doctorRescheduleProblem($appointment, new DateTimeImmutable())) !== null) {
                    return $ended;
                }
                if (!$this->availability->isSlotAvailable($appointment->getSpecialist(), $scheduledAt, false, ignoreAppointmentId: $appointment->getId())) {
                    return false;
                }
                $appointment->setScheduledAt($scheduledAt);
                $appointment->transitionTo(AppointmentStatus::CONFIRMED);
                $appointment->setRescheduledBy('doctor');
                $this->appointments->save($appointment);
                // Documents shared "until after this consultation" follow it, but
                // a doctor's move never stretches them past what the patient
                // agreed + 30 days (pair locks after the slot lock).
                $sharesMoved = $this->sharing->appointmentMoved($appointment, $appointment->getRescheduledBy() ?? 'staff', DocumentSharingRules::now());

                return true;
            });
        } catch (UniqueConstraintViolationException $e) {
            $this->sharing->discardNotices();
            if (!SlotLock::isSlotTaken($e)) {
                throw $e;
            }
            $moved = false;
        } catch (\Throwable $e) {
            $this->sharing->discardNotices();
            throw $e;
        }
        $this->sharing->dispatchNotices();
        if (is_string($moved)) {
            return $this->error($response, $moved, 422, ['status' => $moved]);
        }
        if (!$moved) {
            return $this->error($response, SlotLock::TAKEN, 409, ['scheduled_at' => SlotLock::TAKEN]);
        }

        $this->notify($appointment);
        // One extra, non-PHI sentence when shares anchored to it moved (and sharing is on).
        $suffix = $sharesMoved !== [] && DocumentSharingRules::enabled() ? DocumentAccessNotifier::rescheduleSuffix($sharesMoved) : '';
        $this->patientNotifier->appointment(
            $appointment,
            'Appointment moved by your doctor',
            "Your doctor moved your appointment to a new time and it's confirmed. If the new time doesn't suit you, you can reschedule or cancel it for a full refund before it starts."
                . ($suffix !== '' ? ' ' . $suffix : ''),
        );
        // Guests get the new time with a fresh copy of their link.
        $this->guests->notifyRescheduled($appointment);

        return $this->success($response, $appointment->toArray('doctor'), 'Appointment rescheduled');
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
