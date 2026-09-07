<?php

declare(strict_types=1);

namespace App\Action\Support;

use App\Domain\Entity\SupportTicket;
use App\Domain\Repository\SupportTicketRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/** GET /api/portal/support/tickets — the signed-in patient's own tickets. */
final class ListMyTicketsAction
{
    use ApiResponse;

    public function __construct(private readonly SupportTicketRepository $tickets)
    {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        $customerId = (string) $request->getAttribute('customer_id');
        $p          = $this->getPaginationParams($request->getQueryParams());

        $result = $this->tickets->paginatedForPatient($p['offset'], $p['per_page'], $customerId);

        return $this->paginated(
            $response,
            array_map(static fn (SupportTicket $t): array => $t->toArray(), $result['items']),
            $result['total'],
            $p['page'],
            $p['per_page'],
        );
    }
}
