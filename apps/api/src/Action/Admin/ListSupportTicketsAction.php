<?php

declare(strict_types=1);

namespace App\Action\Admin;

use App\Domain\Entity\SupportTicket;
use App\Domain\Repository\SupportTicketRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/admin/support/tickets?status= — the back-office support queue,
 * optionally filtered by status. Behind RBAC `support.manage`.
 */
final class ListSupportTicketsAction
{
    use ApiResponse;

    public function __construct(private readonly SupportTicketRepository $tickets)
    {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        $query  = $request->getQueryParams();
        $p      = $this->getPaginationParams($query);
        $status = isset($query['status']) ? (string) $query['status'] : null;

        $result = $this->tickets->paginatedAll($p['offset'], $p['per_page'], $status);

        return $this->paginated(
            $response,
            array_map(static fn (SupportTicket $t): array => $t->toArray(), $result['items']),
            $result['total'],
            $p['page'],
            $p['per_page'],
        );
    }
}
