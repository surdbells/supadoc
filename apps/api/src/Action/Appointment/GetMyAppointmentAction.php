<?php

declare(strict_types=1);

namespace App\Action\Appointment;

use App\Domain\Entity\Appointment;
use App\Domain\Exception\EntityNotFoundException;
use App\Domain\Repository\AppointmentRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/portal/appointments/{id} — one of the signed-in customer's own
 * appointments. Scoped by `customer_id`, so another patient's id resolves to a
 * 404 rather than leaking the record.
 */
final class GetMyAppointmentAction
{
    use ApiResponse;

    public function __construct(private readonly AppointmentRepository $repo)
    {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
        array $args,
    ): ResponseInterface {
        $customerId  = (string) $request->getAttribute('customer_id');
        $id          = (string) $args['id'];
        $appointment = $this->repo->findForPatient($id, $customerId);

        if ($appointment === null) {
            throw EntityNotFoundException::for(Appointment::class, $id);
        }

        return $this->success($response, $appointment->toArray());
    }
}
