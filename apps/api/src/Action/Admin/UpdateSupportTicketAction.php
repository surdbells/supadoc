<?php

declare(strict_types=1);

namespace App\Action\Admin;

use App\Domain\Entity\SupportTicket;
use App\Domain\Repository\SupportTicketRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * PATCH /api/admin/support/tickets/{id} — change a ticket's status (e.g. resolve
 * or close it). Behind RBAC `support.manage`.
 */
final class UpdateSupportTicketAction
{
    use ApiResponse;

    public function __construct(private readonly SupportTicketRepository $tickets)
    {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
        array $args,
    ): ResponseInterface {
        $ticket = $this->tickets->find((string) $args['id']);
        if (!$ticket instanceof SupportTicket) {
            return $this->error($response, 'Ticket not found', 404);
        }

        $status = (string) (((array) ($request->getParsedBody() ?? []))['status'] ?? '');
        if (!in_array($status, SupportTicket::STATUSES, true)) {
            return $this->error($response, 'Invalid status', 422, [
                'status' => 'Must be one of: ' . implode(', ', SupportTicket::STATUSES),
            ]);
        }

        $ticket->setStatus($status);
        $this->tickets->save($ticket);

        return $this->success($response, $ticket->toArray(), 'Ticket updated');
    }
}
