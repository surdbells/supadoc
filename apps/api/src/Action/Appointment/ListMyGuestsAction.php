<?php

declare(strict_types=1);

namespace App\Action\Appointment;

use App\Domain\Repository\AppointmentRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\GuestInvitations;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/portal/appointments/{id}/guests — the signed-in patient's guests on
 * one of their consultations: each with their email, status (invited /
 * consented / joined), whether they are in the call now, and their personal
 * join link to copy (for the patient only — it is the guest's credential);
 * plus the guest fee, whether the list can still change (`can_manage`,
 * `can_add`, `manage_problem`), and until when removing one refunds its fee.
 */
final class ListMyGuestsAction
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

        // Join links are bearer credentials: never cache them.
        return $this->success($response, $this->guests->listFor($appointment))->withHeader('Cache-Control', 'no-store');
    }
}
