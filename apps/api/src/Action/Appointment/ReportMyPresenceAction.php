<?php

declare(strict_types=1);

namespace App\Action\Appointment;

use App\Action\Call\CallPresenceAction;
use App\Domain\Entity\Appointment;
use App\Domain\Exception\EntityNotFoundException;
use App\Domain\Repository\AppointmentRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\CallPresence;
use DateTimeImmutable;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/portal/appointments/{id}/presence — the signed-in patient's call
 * screen heartbeat: `{"state":"in"}` every ~15 s while in the call,
 * `{"state":"out"}` on leaving. Scoped by customer_id. An "in" answers who is
 * in the call now and everyone who may be, by Agora uid (names only), so the
 * call screen can label a guest's tile ({@see CallPresenceAction::beat()}).
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

            return $this->success($response, ['state' => $state])->withHeader('Cache-Control', 'no-store');
        }
        $this->presence->mark($appointment, 'patient');
        // Durable evidence the patient came (first heartbeat in the window, stored once).
        $this->appointments->recordPresence($appointment, 'patient', new DateTimeImmutable());

        return $this->success($response, CallPresenceAction::beat($state, $this->presence->forAppointment($appointment), $appointment))
            ->withHeader('Cache-Control', 'no-store');
    }
}
