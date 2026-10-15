<?php

declare(strict_types=1);

namespace App\Action\Appointment;

use App\Domain\Repository\AppointmentRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\GuestInvitations;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/portal/appointments/{id}/guests/{gid}/resend — the signed-in
 * patient re-sends a guest's invitation email (with a fresh copy of their
 * personal link), at most once every 2 minutes per guest: sooner is a 429
 * with `errors.retry_after` (seconds) and a Retry-After header. 422
 * `errors.status` once the guest list can't change; 404 for an unknown guest.
 * Answers the list (as GET .../guests).
 */
final class ResendMyGuestInviteAction
{
    use ApiResponse;

    public function __construct(
        private readonly AppointmentRepository $appointments,
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

        $sent = $this->guests->resend($appointment, (string) $args['gid']);
        if ($sent['retry_after'] !== null) {
            $wait = $sent['retry_after'];
            $soon = sprintf('You can send this invitation again in %d second%s.', $wait, $wait === 1 ? '' : 's');

            return $this->error($response, $soon, 429, ['guest' => $soon, 'retry_after' => $wait])
                ->withHeader('Retry-After', (string) $wait);
        }

        return $this->success($response, $this->guests->listFor($appointment), 'Invitation sent again')
            ->withHeader('Cache-Control', 'no-store');
    }
}
