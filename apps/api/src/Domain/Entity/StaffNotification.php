<?php

declare(strict_types=1);

namespace App\Domain\Entity;

use DateTimeImmutable;
use Doctrine\ORM\Mapping as ORM;
use Ramsey\Uuid\Uuid;

/**
 * An in-app notification for a staff user (doctor/admin) — new bookings, reviews,
 * payout decisions, etc. The customer-facing {@see Notification} is patient-scoped;
 * this one is keyed by the staff user id.
 */
#[ORM\Entity]
#[ORM\Table(name: 'staff_notifications')]
#[ORM\Index(name: 'idx_staff_notifications_user', columns: ['user_id', 'created_at'])]
#[ORM\HasLifecycleCallbacks]
class StaffNotification
{
    use TimestampsTrait;

    #[ORM\Id]
    #[ORM\Column(type: 'uuid')]
    private string $id;

    #[ORM\Column(name: 'user_id', type: 'uuid')]
    private string $userId;

    #[ORM\Column(type: 'string', length: 40)]
    private string $type;

    #[ORM\Column(type: 'string', length: 200)]
    private string $title;

    #[ORM\Column(type: 'text', nullable: true)]
    private ?string $body = null;

    #[ORM\Column(name: 'link', type: 'string', length: 300, nullable: true)]
    private ?string $link = null;

    #[ORM\Column(name: 'read_at', type: 'datetime_immutable', nullable: true)]
    private ?DateTimeImmutable $readAt = null;

    public function __construct(
        string $userId,
        string $type,
        string $title,
        ?string $body = null,
        ?string $link = null,
    ) {
        $this->id     = Uuid::uuid4()->toString();
        $this->userId = $userId;
        $this->type   = $type;
        $this->title  = $title;
        $this->body   = $body !== null && trim($body) !== '' ? trim($body) : null;
        $this->link   = $link !== null && trim($link) !== '' ? trim($link) : null;
    }

    public function getId(): string
    {
        return $this->id;
    }

    public function getUserId(): string
    {
        return $this->userId;
    }

    public function markRead(): void
    {
        $this->readAt = $this->readAt ?? new DateTimeImmutable();
    }

    /** @return array<string,mixed> */
    public function toArray(): array
    {
        return [
            'id'         => $this->id,
            'type'       => $this->type,
            'title'      => $this->title,
            'body'       => $this->body,
            'link'       => $this->link,
            'read'       => $this->readAt !== null,
            'created_at' => $this->createdAt->format(DATE_ATOM),
        ];
    }
}
