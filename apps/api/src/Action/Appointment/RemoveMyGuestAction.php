<?php

declare(strict_types=1);

namespace App\Action\Appointment;

use App\Domain\Repository\AppointmentRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\GuestInvitations;
use App\Infrastructure\Service\PricingService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * DELETE /api/portal/appointments/{id}/guests/{gid} — the signed-in patient
 * removes a guest. Their join link stops working at once (an open call screen
 * of theirs is refused at its next heartbeat), and they are emailed that the
 * invitation was withdrawn. Removed before the consultation starts, a paid
 * guest fee goes back to the wallet (`refunded`); after that, nothing is
 * refunded. 422 `errors.status` once the guest list can't change; 404 for an
 * unknown guest. Answers the remaining list (as GET .../guests).
 */
final class RemoveMyGuestAction
{
    use ApiResponse;

    public function __construct(
        private readonly AppointmentRepository $appointments,
        private readonly GuestInvitations $guests,
        private readonly PricingService $pricing,
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

        $removed  = $this->guests->remove($appointment, (string) $args['gid']);
        $refunded = $removed['refunded'];
        $currency = $this->pricing->currency() === 'NGN' ? '₦' : $this->pricing->currency();
        $message  = $refunded !== null
            ? sprintf('Guest removed. %s%s was refunded to your wallet.', $currency, number_format((float) $refunded, 2))
            : 'Guest removed';

        return $this->success($response, [
            'removed'  => ['id' => (string) $removed['guest']['id'], 'name' => (string) $removed['guest']['name']],
            'refunded' => $refunded,
        ] + $this->guests->listFor($appointment), $message)->withHeader('Cache-Control', 'no-store');
    }
}
