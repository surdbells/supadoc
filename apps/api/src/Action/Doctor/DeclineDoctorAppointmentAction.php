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
use App\Infrastructure\Service\AppointmentPaymentService;
use App\Infrastructure\Service\FollowUpService;
use App\Infrastructure\Service\GuestInvitations;
use App\Infrastructure\Service\PatientNotifier;
use DateTimeImmutable;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use App\Domain\Settings\WebUrls;

/**
 * POST /api/doctor/appointments/{id}/decline — the assigned doctor declines a
 * booking. Cancels it, refunds a paid booking to the patient's wallet, and
 * emails the patient (and each guest that it was cancelled). Declining their own unanswered follow-up proposal
 * withdraws it (see POST .../follow-up/withdraw). Doctor-owned only.
 *
 * When ({@see AppointmentLifecycle::doctorDeclineProblem()}, the payload's
 * `can_decline`): a confirmed booking only before its start (after it, it
 * closes as completed or missed — a no-show can't become a cancellation); a
 * request until CONFIRM_GRACE_MINUTES after its slot ended (then the cron
 * expires it); 422 errors.status otherwise. The cancel + refund run under the
 * row lock on a fresh copy, so a decline racing the cron's missed / expired
 * closing can't refund twice or overwrite it.
 *
 * Body `{reason?}`: an optional message to the patient (trimmed, up to
 * MAX_REASON_LENGTH characters, else 422 errors.reason), shown in their
 * email. It isn't stored.
 */
final class DeclineDoctorAppointmentAction
{
    use ApiResponse;
    use ResolvesDoctorAppointment;

    /** The longest message to the patient. */
    public const MAX_REASON_LENGTH = 500;

    public function __construct(
        private readonly UserRepository $users,
        private readonly AppointmentRepository $appointments,
        private readonly AppointmentPaymentService $payments,
        private readonly MailService $mail,
        private readonly PatientNotifier $patientNotifier,
        private readonly FollowUpService $followUps,
        private readonly GuestInvitations $guests,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
        array $args,
    ): ResponseInterface {
        $note = self::note((array) ($request->getParsedBody() ?? []));
        if (is_array($note)) {
            return $this->error($response, $note['reason'], 422, $note);
        }

        $appointment = $this->doctorAppointment($request, $this->users, $this->appointments, (string) $args['id']);
        if ($appointment === null) {
            return $this->error($response, 'You cannot manage this appointment', 403);
        }

        $current = $appointment->getStatus();
        if ($current === AppointmentStatus::PROPOSED) {
            $this->followUps->withdraw($appointment);

            return $this->success($response, $appointment->toArray('doctor'), 'Follow-up withdrawn');
        }
        if ($current === AppointmentStatus::CANCELLED) {
            return $this->success($response, $appointment->toArray('doctor'), 'Appointment already cancelled');
        }
        if (($problem = $this->declineProblem($appointment)) !== null) {
            return $this->error($response, $problem, 422, ['status' => $problem]);
        }

        // Under the row lock, re-read: the cron may have just closed it (marked
        // missed with its own refund, or expired it) — never cancel and refund
        // a stale copy over that.
        $outcome = $this->appointments->transactional(function () use ($appointment): string {
            $this->appointments->lockAndRefresh($appointment);
            if ($appointment->getStatus() === AppointmentStatus::CANCELLED) {
                return 'already';
            }
            if (($problem = $this->declineProblem($appointment)) !== null) {
                return $problem;
            }
            $appointment->transitionTo(AppointmentStatus::CANCELLED);
            $this->payments->refundForCancellation($appointment);
            $this->appointments->save($appointment);

            return 'declined';
        });
        if ($outcome === 'already') {
            return $this->success($response, $appointment->toArray('doctor'), 'Appointment already cancelled');
        }
        if ($outcome !== 'declined') {
            return $this->error($response, $outcome, 422, ['status' => $outcome]);
        }

        $this->notify($appointment, $note);
        $this->patientNotifier->appointment($appointment, 'Appointment declined', 'Unfortunately your appointment was declined and any payment refunded.');
        $this->guests->notifyCancelled($appointment);

        return $this->success($response, $appointment->toArray('doctor'), 'Appointment declined');
    }

    /**
     * The doctor's optional message to the patient from the body: trimmed, null
     * when absent or blank — or the field errors when it isn't text or is too long.
     *
     * @param array<string,mixed> $body
     * @return string|array{reason:string}|null
     */
    public static function note(array $body): string|array|null
    {
        $reason = $body['reason'] ?? null;
        if ($reason === null) {
            return null;
        }
        if (!is_string($reason)) {
            return ['reason' => 'The message to the patient must be text'];
        }
        $reason = trim($reason);
        if (mb_strlen($reason) > self::MAX_REASON_LENGTH) {
            return ['reason' => 'Keep the message to the patient to ' . self::MAX_REASON_LENGTH . ' characters or fewer'];
        }

        return $reason !== '' ? $reason : null;
    }

    /**
     * Why it can't be declined now, or null: not an open booking any more,
     * or outside the doctor's window ({@see AppointmentLifecycle::doctorDeclineProblem()}).
     */
    private function declineProblem(Appointment $appointment): ?string
    {
        if (!$appointment->getStatus()->canTransitionTo(AppointmentStatus::CANCELLED)) {
            return 'This appointment can no longer be declined';
        }

        return AppointmentLifecycle::doctorDeclineProblem($appointment, new DateTimeImmutable());
    }

    private function notify(Appointment $appointment, ?string $note): void
    {
        try {
            $p    = $appointment->getPatient()->toArray();
            $mail = EmailTemplates::appointmentStatusUpdate(
                $appointment->toArray(),
                (string) ($p['first_name'] ?? ''),
                WebUrls::forPatient($appointment->getPatient()),
                $note,
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
