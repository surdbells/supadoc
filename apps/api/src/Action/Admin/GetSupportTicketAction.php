<?php

declare(strict_types=1);

namespace App\Action\Admin;

use App\Domain\Entity\SupportMessage;
use App\Domain\Entity\SupportTicket;
use App\Domain\Repository\SupportMessageRepository;
use App\Domain\Repository\SupportTicketRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/admin/support/tickets/{id} — one ticket with its full thread, for the
 * back office. Behind RBAC `support.manage`.
 */
final class GetSupportTicketAction
{
    use ApiResponse;

    public function __construct(
        private readonly SupportTicketRepository $tickets,
        private readonly SupportMessageRepository $messages,
    ) {
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

        return $this->success($response, [
            'ticket'   => $ticket->toArray(),
            'messages' => array_map(
                static fn (SupportMessage $m): array => $m->toArray(),
                $this->messages->forTicket($ticket->getId()),
            ),
        ]);
    }
}
