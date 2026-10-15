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
use App\Infrastructure\Service\AppointmentPaymentService;
use App\Infrastructure\Service\FollowUpService;
use App\Infrastructure\Service\GuestInvitations;
use App\Infrastructure\Service\PatientNotifier;
use App\Infrastructure\Service\StaffNotifier;
use DateTimeImmutable;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use App\Domain\Settings\WebUrls;

/**
 * POST /api/portal/appointments/{id}/cancel — the signed-in patient cancels their
 * own booking. If it was paid from the wallet, the fee is refunded (idempotently)
 * and a refund receipt is emailed; the patient also gets a cancellation email,
 * and each guest a "consultation cancelled" one (their links stop working).
 * Cancelling a follow-up proposal the patient hasn't accepted declines it
 * (see POST .../follow-up/decline): nothing was paid, the doctor is told.
 *
 * Only before the start (422 "This consultation has started" after it: the
 * outcome is then decided by the consultation being completed or marked
 * missed). A request the doctor hasn't confirmed refunds in full; a confirmed
 * one too — unless the Booking settings' late window applies
 * (late_cancel_hours before the start, 0 = off), which refunds
 * late_cancel_refund_pct of the fee (guest fees always in full) under
 * `appt_late_cancel_refund_<id>`.
 */
final class CancelMyAppointmentAction
{
    use ApiResponse;

    public function __construct(
        private readonly AppointmentRepository $appointments,
        private readonly AppointmentPaymentService $payments,
        private readonly MailService $mail,
        private readonly PatientNotifier $patientNotifier,
        private readonly StaffNotifier $staffNotifier,
        private readonly FollowUpService $followUps,
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

        $current = $appointment->getStatus();
        if ($current === AppointmentStatus::PROPOSED) {
            $this->followUps->decline($appointment, null);

            return $this->success($response, $appointment->toArray(), 'Follow-up declined');
        }
        if ($current === AppointmentStatus::CANCELLED) {
            return $this->success($response, $appointment->toArray(), 'Appointment already cancelled');
        }
        if (!$current->canTransitionTo(AppointmentStatus::CANCELLED)) {
            return $this->error($response, 'This appointment can no longer be cancelled', 422, [
                'status' => 'Not cancellable',
            ]);
        }

        $now = new DateTimeImmutable();
        if (($started = AppointmentLifecycle::patientChangeProblem($appointment, $now)) !== null) {
            return $this->error($response, $started, 422, ['status' => $started]);
        }
        $percent = AppointmentLifecycle::cancelRefundPercent(
            $appointment,
            $now,
            $this->settings->get('late_cancel_hours'),
            $this->settings->get('late_cancel_refund_pct'),
        );

        $appointment->transitionTo(AppointmentStatus::CANCELLED);
        if ($percent >= 100) {
            // Refund the wallet if it was paid (sets payment_status='refunded').
            $this->payments->refundForCancellation($appointment);
        } else {
            $this->payments->refundPart(
                $appointment,
                AppointmentLifecycle::partialRefund($appointment, $percent),
                'appt_late_cancel_refund_' . $appointment->getId(),
                'Refund for a late cancellation — consultation with ' . $appointment->getSpecialist()->getName(),
            );
        }
        $this->appointments->save($appointment);

        $this->notifyCancelled($appointment);
        $this->patientNotifier->appointment($appointment, 'Appointment cancelled', $percent >= 100
            ? 'Your appointment was cancelled and any wallet payment refunded.'
            : 'Your appointment was cancelled. Under the late-cancellation policy, part of your payment was refunded to your wallet.');
        $this->notifyDoctor($appointment);
        $this->guests->notifyCancelled($appointment);

        return $this->success($response, $appointment->toArray(), 'Appointment cancelled');
    }

    /** Tell the assigned doctor their slot reopened (in-app; best-effort). */
    private function notifyDoctor(Appointment $appointment): void
    {
        $appt        = $appointment->toArray();
        $p           = $appointment->getPatient()->toArray();
        $patientName = trim((string) ($p['first_name'] ?? '') . ' ' . (string) ($p['last_name'] ?? ''));
        $this->staffNotifier->notifyDoctor(
            $appointment->getSpecialist()->getId(),
            'appointment',
            'Booking cancelled',
            ($patientName !== '' ? $patientName : 'A patient') . ' cancelled their ' . (string) $appt['type_label'] . '.',
            '/schedule',
        );
    }

    /** Fire-and-forget cancellation email to the patient. */
    private function notifyCancelled(Appointment $appointment): void
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
            // logged inside MailService; the cancellation already succeeded.
        }
    }
}
