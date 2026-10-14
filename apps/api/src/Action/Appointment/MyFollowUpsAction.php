<?php

declare(strict_types=1);

namespace App\Action\Appointment;

use App\Domain\Entity\Appointment;
use App\Domain\Repository\AppointmentRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/portal/appointments/{id}/follow-ups — the follow-ups of one of the
 * signed-in patient's consultations (any status: a proposal awaiting their
 * answer, booked, cancelled…), soonest first.
 */
final class MyFollowUpsAction
{
    use ApiResponse;

    public function __construct(private readonly AppointmentRepository $appointments)
    {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
        array $args,
    ): ResponseInterface {
        $customerId = (string) $request->getAttribute('customer_id');
        $parent     = $this->appointments->findForPatient((string) $args['id'], $customerId);
        if ($parent === null) {
            return $this->error($response, 'Appointment not found', 404);
        }

        return $this->success($response, array_map(
            static fn (Appointment $a): array => $a->toArray(),
            $this->appointments->followUpsOf($parent->getId()),
        ));
    }
}
