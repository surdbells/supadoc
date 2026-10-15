<?php

declare(strict_types=1);

namespace App\Action\Appointment;

use App\Domain\Entity\Appointment;
use App\Domain\Repository\AppointmentRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\AppointmentCheckout;
use App\Infrastructure\Service\GuestInvitations;
use DateTimeImmutable;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/portal/appointments/{id}/guests/pay-init — start a card payment
 * (Paystack) of the guest fee for inviting one more guest to consultation
 * {id}. Checked first, so the patient never pays for a guest that can't be
 * added: the list must still be open (422 `errors.status`) and not full (422
 * `errors.guests`). A guest fee of 0 has nothing to charge (422
 * `errors.payment = free` — add the guest directly). Then POST .../guests with
 * `payment_method: card` and the returned `reference`. The checkout returns
 * to the appointment's page.
 */
final class InitGuestPaymentAction
{
    use ApiResponse;

    public function __construct(
        private readonly AppointmentRepository $appointments,
        private readonly AppointmentCheckout $checkout,
        private readonly GuestInvitations $guests,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
        array $args,
    ): ResponseInterface {
        $appointment = $this->appointments->findForPatient((string) $args['id'], (string) $request->getAttribute('customer_id'));
        if ($appointment === null) {
            return $this->error($response, 'Appointment not found', 404);
        }
        if (($problem = GuestInvitations::manageProblem($appointment, new DateTimeImmutable())) !== null) {
            return $this->error($response, $problem, 422, ['status' => $problem]);
        }
        if (count($appointment->getGuests()) >= Appointment::MAX_GUESTS) {
            $full = 'You can invite at most ' . Appointment::MAX_GUESTS . ' guests';

            return $this->error($response, $full, 422, ['guests' => $full]);
        }

        $patient = $appointment->getPatient();
        $fee     = $this->guests->fee();
        if (($problem = $this->checkout->startProblem($patient, $fee)) !== null) {
            [$status, $message, $errors] = $problem;
            if (($errors['payment'] ?? null) === 'free') {
                $message = 'Inviting a guest is free — no payment is needed.';
            }

            return $this->error($response, $message, $status, $errors);
        }

        try {
            $init = $this->checkout->initialize($patient, $fee, '/dashboard/appointments/' . $appointment->getId(), [
                'appointment_id' => $appointment->getId(),
                'specialist_id'  => $appointment->getSpecialist()->getId(),
                'purpose'        => 'guest_invite',
            ]);
        } catch (\Throwable $e) {
            error_log('[guests.pay-init] paystack initialize failed: ' . $e->getMessage());

            return $this->error($response, 'Could not start the payment. Please try again.', 502);
        }

        return $this->created($response, $init, 'Payment started')->withHeader('Cache-Control', 'no-store');
    }
}
