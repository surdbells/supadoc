<?php

declare(strict_types=1);

namespace App\Action\Admin;

use App\Domain\Entity\Notification;
use App\Domain\Entity\SupportMessage;
use App\Domain\Entity\SupportTicket;
use App\Domain\Enum\NotificationType;
use App\Domain\Repository\NotificationRepository;
use App\Domain\Repository\PatientRepository;
use App\Domain\Repository\SupportMessageRepository;
use App\Domain\Repository\SupportTicketRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/admin/support/tickets/{id}/messages — a staff reply. Moves the
 * ticket to `pending` and drops an in-app notification for the patient. Behind
 * RBAC `support.manage`.
 */
final class ReplySupportTicketAction
{
    use ApiResponse;

    public function __construct(
        private readonly UserRepository $users,
        private readonly PatientRepository $patients,
        private readonly SupportTicketRepository $tickets,
        private readonly SupportMessageRepository $messages,
        private readonly NotificationRepository $notifications,
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

        $body = trim((string) (((array) ($request->getParsedBody() ?? []))['body'] ?? ''));
        if ($body === '') {
            return $this->error($response, 'Message cannot be empty', 422, ['body' => 'A message is required']);
        }

        $author = $this->staffName((string) $request->getAttribute('user_id'));

        $message = new SupportMessage($ticket->getId(), SupportTicket::ROLE_STAFF, $author, $body);
        $this->messages->save($message);

        $ticket->registerMessage(SupportTicket::ROLE_STAFF, $body);
        $this->tickets->save($ticket);

        $this->notifyPatient($ticket, $body);

        return $this->created($response, $message->toArray(), 'Reply sent');
    }

    private function staffName(string $userId): string
    {
        $user = $userId !== '' ? $this->users->find($userId) : null;
        if ($user === null) {
            return 'Support';
        }
        $u    = $user->toArray();
        $name = trim((string) ($u['first_name'] ?? '') . ' ' . (string) ($u['last_name'] ?? ''));

        return $name !== '' ? $name : 'Support';
    }

    /** Fire-and-forget in-app notification so the patient sees the reply. */
    private function notifyPatient(SupportTicket $ticket, string $body): void
    {
        try {
            $patient = $this->patients->find($ticket->getPatientId());
            if ($patient === null) {
                return;
            }
            $preview = mb_strlen($body) > 120 ? mb_substr($body, 0, 117) . '…' : $body;
            $this->notifications->save(new Notification(
                $patient,
                NotificationType::SYSTEM,
                'Support replied to your ticket',
                $preview,
            ));
        } catch (\Throwable) {
            // non-fatal — the reply was already saved.
        }
    }
}
