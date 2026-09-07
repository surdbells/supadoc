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
 * POST /api/portal/support/tickets — open a support ticket. Creates the ticket
 * plus its first message from the signed-in patient.
 */
final class CreateTicketAction
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
    ): ResponseInterface {
        $customerId = (string) $request->getAttribute('customer_id');
        $body       = (array) ($request->getParsedBody() ?? []);

        $subject  = trim((string) ($body['subject'] ?? ''));
        $category = (string) ($body['category'] ?? 'general');
        $message  = trim((string) ($body['message'] ?? ''));

        $errors = [];
        if ($subject === '') {
            $errors['subject'] = 'A subject is required';
        }
        if ($message === '') {
            $errors['message'] = 'Describe how we can help';
        }
        if ($errors !== []) {
            return $this->error($response, 'Validation failed', 422, $errors);
        }

        /** @var Patient $patient */
        $patient = $this->patients->findOrFail($customerId);
        $p       = $patient->toArray();
        $name    = trim((string) ($p['first_name'] ?? '') . ' ' . (string) ($p['last_name'] ?? ''));

        $ticket = new SupportTicket($customerId, $name, (string) ($p['email'] ?? ''), $subject, $category);
        $ticket->registerMessage(SupportTicket::ROLE_PATIENT, $message);
        $this->tickets->save($ticket);

        $this->messages->save(new SupportMessage($ticket->getId(), SupportTicket::ROLE_PATIENT, $name ?: 'Patient', $message));

        return $this->created($response, $ticket->toArray(), 'Ticket created');
    }
}
