<?php

declare(strict_types=1);

namespace App\Domain\Entity;

use App\Domain\Enum\NotificationType;
use DateTimeImmutable;
use Doctrine\ORM\Mapping as ORM;
use Ramsey\Uuid\Uuid;

/** A patient-facing notification. `toArray()` is the serialisation boundary. */
#[ORM\Entity]
#[ORM\Table(name: 'notifications')]
#[ORM\Index(name: 'idx_notifications_patient', columns: ['patient_id'])]
#[ORM\HasLifecycleCallbacks]
class Notification
{
    use TimestampsTrait;

    #[ORM\Id]
    #[ORM\Column(type: 'uuid')]
    private string $id;

    #[ORM\ManyToOne(targetEntity: Patient::class)]
    #[ORM\JoinColumn(name: 'patient_id', referencedColumnName: 'id', nullable: false)]
    private Patient $patient;

    #[ORM\Column(type: 'string', length: 20, enumType: NotificationType::class)]
    private NotificationType $type;

    #[ORM\Column(type: 'string', length: 160)]
    private string $title;

    #[ORM\Column(type: 'text')]
    private string $body;

    #[ORM\Column(name: 'read_at', type: 'datetime_immutable', nullable: true)]
    private ?DateTimeImmutable $readAt = null;

    public function __construct(
        Patient $patient,
        NotificationType $type,
        string $title,
        string $body,
    ) {
        $this->id      = Uuid::uuid4()->toString();
        $this->patient = $patient;
        $this->type    = $type;
        $this->title   = $title;
        $this->body    = $body;
    }

    public function getId(): string
    {
        return $this->id;
    }

    public function markRead(): void
    {
        $this->readAt ??= new DateTimeImmutable();
    }

    public function isRead(): bool
    {
        return $this->readAt !== null;
    }

    public function toArray(): array
    {
        return [
            'id'         => $this->id,
            'type'       => $this->type->value,
            'type_label' => $this->type->label(),
            'title'      => $this->title,
            'body'       => $this->body,
            'read'       => $this->readAt !== null,
            'created_at' => $this->createdAt->format(DATE_ATOM),
        ];
    }
}
