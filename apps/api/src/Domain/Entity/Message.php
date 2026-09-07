<?php

declare(strict_types=1);

namespace App\Domain\Entity;

use DateTimeImmutable;
use Doctrine\ORM\Mapping as ORM;
use Ramsey\Uuid\Uuid;

/**
 * One message in a consultation's async thread between the patient and their
 * doctor. Scoped to an appointment; both parties can read + post. `readAt` is
 * set once the *other* party has seen it, which drives the unread badges.
 */
#[ORM\Entity]
#[ORM\Table(name: 'messages')]
#[ORM\Index(name: 'idx_messages_appointment', columns: ['appointment_id', 'created_at'])]
#[ORM\HasLifecycleCallbacks]
class Message
{
    use TimestampsTrait;

    public const ROLE_PATIENT = 'patient';
    public const ROLE_DOCTOR  = 'doctor';

    #[ORM\Id]
    #[ORM\Column(type: 'uuid')]
    private string $id;

    #[ORM\Column(name: 'appointment_id', type: 'uuid')]
    private string $appointmentId;

    #[ORM\Column(name: 'sender_role', type: 'string', length: 10)]
    private string $senderRole;

    #[ORM\Column(name: 'sender_name', type: 'string', length: 200)]
    private string $senderName;

    #[ORM\Column(type: 'text')]
    private string $body;

    #[ORM\Column(name: 'read_at', type: 'datetime_immutable', nullable: true)]
    private ?DateTimeImmutable $readAt = null;

    public function __construct(string $appointmentId, string $senderRole, string $senderName, string $body)
    {
        $this->id            = Uuid::uuid4()->toString();
        $this->appointmentId = $appointmentId;
        $this->senderRole    = $senderRole;
        $this->senderName    = $senderName;
        $this->body          = $body;
    }

    public function getId(): string
    {
        return $this->id;
    }

    public function getSenderRole(): string
    {
        return $this->senderRole;
    }

    /** @return array<string,mixed> */
    public function toArray(): array
    {
        return [
            'id'             => $this->id,
            'appointment_id' => $this->appointmentId,
            'sender_role'    => $this->senderRole,
            'sender_name'    => $this->senderName,
            'body'           => $this->body,
            'read'           => $this->readAt !== null,
            'created_at'     => $this->createdAt->format(DATE_ATOM),
        ];
    }
}
