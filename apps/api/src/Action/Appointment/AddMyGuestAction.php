<?php

declare(strict_types=1);

namespace App\Action\Appointment;

use App\Domain\Repository\AppointmentRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\GuestInvitations;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/portal/appointments/{id}/guests — the signed-in patient invites a
 * guest to an upcoming consultation: `{name, email, payment_method?:
 * wallet|card, payment_reference?}`.
 *
 * Pending / confirmed / rescheduled only, until the guest join window closes
 * (422 `errors.status`); at most 3 guests; the email must be valid and not
 * the patient's, the doctor's or an invited guest's (422 `errors.name` /
 * `errors.email` / `errors.guests`). The back-office guest fee is charged
 * unless it is 0: from the wallet (too low → 422 `errors.wallet =
 * insufficient_funds`), or by card with the reference from POST
 * .../guests/pay-init (422 `errors.payment_reference` / `errors.payment`). The
 * guest is emailed their personal link naming who invited them, the doctor is
 * told in-app, and it is audited. Answers 201 with the new `guest` and the
 * whole list (as GET .../guests).
 */
final class AddMyGuestAction
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

        $body  = (array) ($request->getParsedBody() ?? []);
        $guest = $this->guests->add(
            $appointment,
            (string) ($body['name'] ?? ''),
            (string) ($body['email'] ?? ''),
            (string) ($body['payment_method'] ?? ''),
            (string) ($body['payment_reference'] ?? ''),
        );
        $list = $this->guests->listFor($appointment);
        $new  = null;
        foreach ($list['guests'] as $row) {
            if ($row['id'] === $guest['id']) {
                $new = $row;
            }
        }

        return $this->created($response, ['guest' => $new] + $list, 'Guest invited')->withHeader('Cache-Control', 'no-store');
    }
}
