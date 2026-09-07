<?php

declare(strict_types=1);

namespace App\Domain\Entity;

use Doctrine\ORM\Mapping as ORM;
use Ramsey\Uuid\Uuid;

/** One message in a {@see SupportTicket} thread, from the patient or a staff member. */
#[ORM\Entity]
#[ORM\Table(name: 'support_messages')]
#[ORM\Index(name: 'idx_support_messages_ticket', columns: ['ticket_id', 'created_at'])]
#[ORM\HasLifecycleCallbacks]
class SupportMessage
{
    use TimestampsTrait;

    #[ORM\Id]
    #[ORM\Column(type: 'uuid')]
    private string $id;

    #[ORM\Column(name: 'ticket_id', type: 'uuid')]
    private string $ticketId;

    #[ORM\Column(name: 'author_role', type: 'string', length: 10)]
    private string $authorRole;

    #[ORM\Column(name: 'author_name', type: 'string', length: 200)]
    private string $authorName;

    #[ORM\Column(type: 'text')]
    private string $body;

    public function __construct(string $ticketId, string $authorRole, string $authorName, string $body)
    {
        $this->id         = Uuid::uuid4()->toString();
        $this->ticketId   = $ticketId;
        $this->authorRole = $authorRole === SupportTicket::ROLE_STAFF ? SupportTicket::ROLE_STAFF : SupportTicket::ROLE_PATIENT;
        $this->authorName = $authorName !== '' ? $authorName : 'User';
        $this->body       = $body;
    }

    public function getId(): string
    {
        return $this->id;
    }

    /** @return array<string,mixed> */
    public function toArray(): array
    {
        return [
            'id'          => $this->id,
            'ticket_id'   => $this->ticketId,
            'author_role' => $this->authorRole,
            'author_name' => $this->authorName,
            'body'        => $this->body,
            'created_at'  => $this->getCreatedAt()->format(DATE_ATOM),
        ];
    }
}
