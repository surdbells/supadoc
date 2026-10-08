<?php

declare(strict_types=1);

namespace App\Action\Appointment;

use App\Action\Call\CallPresenceAction;
use App\Domain\Entity\Appointment;
use App\Domain\Exception\EntityNotFoundException;
use App\Domain\Repository\AppointmentRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\CallPresence;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/portal/appointments/{id}/presence — the signed-in patient's call
 * screen heartbeat: `{"state":"in"}` every ~15 s while in the call,
 * `{"state":"out"}` on leaving. Scoped by customer_id.
 */
final class ReportMyPresenceAction
{
    use ApiResponse;

    public function __construct(
        private readonly AppointmentRepository $appointments,
        private readonly CallPresence $presence,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
        array $args,
    ): ResponseInterface {
        $id          = (string) $args['id'];
        $appointment = $this->appointments->findForPatient($id, (string) $request->getAttribute('customer_id'));
        if ($appointment === null) {
            throw EntityNotFoundException::for(Appointment::class, $id);
        }

        $state = CallPresenceAction::state($request);
        if ($state === 'out') {
            $this->presence->clear($appointment, 'patient');
        } else {
            $this->presence->mark($appointment, 'patient');
        }

        return $this->success($response, ['state' => $state])->withHeader('Cache-Control', 'no-store');
    }
}
