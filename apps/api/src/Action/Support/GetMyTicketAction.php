<?php

declare(strict_types=1);

namespace App\Action\Support;

use App\Domain\Entity\SupportMessage;
use App\Domain\Entity\SupportTicket;
use App\Domain\Repository\SupportMessageRepository;
use App\Domain\Repository\SupportTicketRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/portal/support/tickets/{id} — one of the patient's own tickets with
 * its full message thread. Scoped by customer_id, so another patient's id 404s.
 */
final class GetMyTicketAction
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
        $customerId = (string) $request->getAttribute('customer_id');
        $ticket     = $this->tickets->find((string) $args['id']);
        if (!$ticket instanceof SupportTicket || $ticket->getPatientId() !== $customerId) {
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
