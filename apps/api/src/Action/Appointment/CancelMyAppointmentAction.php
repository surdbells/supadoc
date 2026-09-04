<?php

declare(strict_types=1);

namespace App\Action\Appointment;

use App\Domain\Entity\Appointment;
use App\Domain\Enum\AppointmentStatus;
use App\Domain\Repository\AppointmentRepository;
use App\Infrastructure\Email\EmailTemplates;
use App\Infrastructure\Email\MailService;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\AppointmentPaymentService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/portal/appointments/{id}/cancel — the signed-in patient cancels their
 * own booking. If it was paid from the wallet, the fee is refunded (idempotently)
 * and a refund receipt is emailed; the patient also gets a cancellation email.
 */
final class CancelMyAppointmentAction
{
    use ApiResponse;

    public function __construct(
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
        $customerId  = (string) $request->getAttribute('customer_id');
        $appointment = $this->appointments->findForPatient((string) $args['id'], $customerId);
        if ($appointment === null) {
            return $this->error($response, 'Appointment not found', 404);
        }

        $current = $appointment->getStatus();
        if ($current === AppointmentStatus::CANCELLED) {
            return $this->success($response, $appointment->toArray(), 'Appointment already cancelled');
        }
        if (!$current->canTransitionTo(AppointmentStatus::CANCELLED)) {
            return $this->error($response, 'This appointment can no longer be cancelled', 422, [
                'status' => 'Not cancellable',
            ]);
        }

        $appointment->transitionTo(AppointmentStatus::CANCELLED);
        // Refund the wallet if it was paid (sets payment_status='refunded').
        $this->payments->refundForCancellation($appointment);
        $this->appointments->save($appointment);

        $this->notifyCancelled($appointment);

        return $this->success($response, $appointment->toArray(), 'Appointment cancelled');
    }

    /** Fire-and-forget cancellation email to the patient. */
    private function notifyCancelled(Appointment $appointment): void
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
            // logged inside MailService; the cancellation already succeeded.
        }
    }
}
