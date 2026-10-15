<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Domain\Appointment\AppointmentLifecycle;
use App\Domain\Entity\Appointment;
use App\Domain\Enum\AppointmentStatus;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Email\EmailTemplates;
use App\Infrastructure\Email\MailService;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\PatientNotifier;
use DateTimeImmutable;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use App\Domain\Settings\WebUrls;

/**
 * POST /api/doctor/appointments/{id}/confirm — the assigned doctor confirms a
 * pending booking. Moves it PENDING/RESCHEDULED → CONFIRMED and emails the
 * patient. A doctor can only ever confirm their own consultations, and only
 * until AppointmentLifecycle::CONFIRM_GRACE_MINUTES after its slot ended (422
 * after that — the cron closes it as not confirmed, refunding the patient).
 * The change runs under the row lock on a fresh copy, so it can't overwrite
 * the cron's closing of it.
 */
final class ConfirmDoctorAppointmentAction
{
    use ApiResponse;
    use ResolvesDoctorAppointment;

    public function __construct(
        private readonly UserRepository $users,
        private readonly AppointmentRepository $appointments,
        private readonly MailService $mail,
        private readonly PatientNotifier $patientNotifier,
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
            return $this->success($response, $appointment->toArray('doctor'), 'Appointment already confirmed');
        }
        // A proposal is confirmed by the patient accepting (and paying for) it.
        if ($current === AppointmentStatus::PROPOSED) {
            $waiting = 'This follow-up is waiting for the patient to accept it';

            return $this->error($response, $waiting, 422, ['status' => $waiting]);
        }
        if (!$current->canTransitionTo(AppointmentStatus::CONFIRMED)) {
            return $this->error($response, 'This appointment cannot be confirmed', 422, [
                'status' => 'Not confirmable',
            ]);
        }
        if (($ended = AppointmentLifecycle::doctorConfirmProblem($appointment, new DateTimeImmutable())) !== null) {
            return $this->error($response, $ended, 422, ['status' => $ended]);
        }

        // Under the row lock, re-read: the cron expires an unconfirmed request
        // (cancelled + refunded) right as the confirm window closes — never
        // confirm a stale copy over that.
        $outcome = $this->appointments->transactional(function () use ($appointment): ?string {
            $this->appointments->lockAndRefresh($appointment);
            if ($appointment->getStatus() === AppointmentStatus::CONFIRMED) {
                return 'already';
            }
            if (!$appointment->getStatus()->canTransitionTo(AppointmentStatus::CONFIRMED)) {
                return 'This appointment cannot be confirmed';
            }
            if (($ended = AppointmentLifecycle::doctorConfirmProblem($appointment, new DateTimeImmutable())) !== null) {
                return $ended;
            }
            $appointment->transitionTo(AppointmentStatus::CONFIRMED);
            $this->appointments->save($appointment);

            return null;
        });
        if ($outcome === 'already') {
            return $this->success($response, $appointment->toArray('doctor'), 'Appointment already confirmed');
        }
        if ($outcome !== null) {
            return $this->error($response, $outcome, 422, ['status' => $outcome]);
        }

        $this->notifyConfirmed($appointment);
        $this->patientNotifier->appointment($appointment, 'Appointment confirmed', 'Your appointment is confirmed.');

        return $this->success($response, $appointment->toArray('doctor'), 'Appointment confirmed');
    }

    /** Fire-and-forget confirmation email to the patient. */
    private function notifyConfirmed(Appointment $appointment): void
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
            // logged inside MailService; the confirmation already succeeded.
        }
    }
}
