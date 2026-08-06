<?php

declare(strict_types=1);

namespace App\Action\Appointment;

use App\Domain\Repository\AppointmentRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/portal/appointments — the signed-in customer's own appointments.
 * `customer_id` comes from CustomerAuthMiddleware, so a customer can only ever
 * read their own records.
 */
final class ListMyAppointmentsAction
{
    use ApiResponse;

    public function __construct(private readonly AppointmentRepository $repo)
    {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        $customerId = (string) $request->getAttribute('customer_id');
        $p          = $this->getPaginationParams($request->getQueryParams());

        $result = $this->repo->paginated(
            $p['offset'],
            $p['per_page'],
            $p['sort_by'],
            $p['sort_dir'],
            $customerId,
        );

        return $this->paginated(
            $response,
            array_map(static fn ($a) => $a->toArray(), $result['items']),
            $result['total'],
            $p['page'],
            $p['per_page'],
        );
    }
}
