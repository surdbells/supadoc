<?php

declare(strict_types=1);

namespace App\Action\Support;

use App\Domain\Entity\Patient;
use App\Domain\Entity\SupportMessage;
use App\Domain\Entity\SupportTicket;
use App\Domain\Repository\PatientRepository;
use App\Domain\Repository\SupportMessageRepository;
use App\Domain\Repository\SupportTicketRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/portal/support/tickets/{id}/messages — the patient adds a reply,
 * which reopens the ticket. Scoped by customer_id; a closed ticket is read-only.
 */
final class ReplyToMyTicketAction
{
    use ApiResponse;

    public function __construct(
        private readonly PatientRepository $patients,
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
        if ($ticket->getStatus() === 'closed') {
            return $this->error($response, 'This ticket is closed. Please open a new one.', 422, ['status' => 'closed']);
        }

        $body = trim((string) (((array) ($request->getParsedBody() ?? []))['body'] ?? ''));
        if ($body === '') {
            return $this->error($response, 'Message cannot be empty', 422, ['body' => 'A message is required']);
        }

        /** @var Patient $patient */
        $patient = $this->patients->findOrFail($customerId);
        $p       = $patient->toArray();
        $name    = trim((string) ($p['first_name'] ?? '') . ' ' . (string) ($p['last_name'] ?? '')) ?: 'Patient';

        $message = new SupportMessage($ticket->getId(), SupportTicket::ROLE_PATIENT, $name, $body);
        $this->messages->save($message);

        $ticket->registerMessage(SupportTicket::ROLE_PATIENT, $body);
        $this->tickets->save($ticket);

        return $this->created($response, $message->toArray(), 'Reply sent');
    }
}
