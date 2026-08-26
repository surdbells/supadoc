<?php

declare(strict_types=1);

namespace App\Domain\Entity;

use DateTimeImmutable;
use Doctrine\ORM\Mapping as ORM;
use Ramsey\Uuid\Uuid;

/**
 * An immutable audit record of a clinically significant action (note finalized,
 * prescription signed, record shared, consent granted, …). Append-only — there
 * are no setters and no updatedAt: an event, once written, is never changed.
 * See ARCHITECTURE §audit.
 */
#[ORM\Entity]
#[ORM\Table(name: 'audit_events')]
#[ORM\Index(name: 'idx_audit_appointment', columns: ['appointment_id'])]
#[ORM\Index(name: 'idx_audit_action', columns: ['action'])]
class AuditEvent
{
    #[ORM\Id]
    #[ORM\Column(type: 'uuid')]
    private string $id;

    /** Display name of who performed the action (doctor/patient/system). */
    #[ORM\Column(name: 'actor_name', type: 'string', length: 200)]
    private string $actorName;

    #[ORM\Column(name: 'actor_role', type: 'string', length: 40)]
    private string $actorRole;

    /** Dotted action key, e.g. "note.finalized", "prescription.signed". */
    #[ORM\Column(type: 'string', length: 60)]
    private string $action;

    #[ORM\Column(name: 'appointment_id', type: 'uuid', nullable: true)]
    private ?string $appointmentId;

    #[ORM\Column(name: 'resource_type', type: 'string', length: 60, nullable: true)]
    private ?string $resourceType;

    #[ORM\Column(name: 'resource_id', type: 'string', length: 64, nullable: true)]
    private ?string $resourceId;

    /** @var array<string,mixed>|null */
    #[ORM\Column(type: 'json', nullable: true)]
    private ?array $metadata;

    #[ORM\Column(name: 'created_at', type: 'datetime_immutable')]
    private DateTimeImmutable $createdAt;

    /**
     * @param array<string,mixed> $metadata
     */
    public function __construct(
        string $actorName,
        string $actorRole,
        string $action,
        ?string $appointmentId = null,
        ?string $resourceType = null,
        ?string $resourceId = null,
        array $metadata = [],
    ) {
        $this->id            = Uuid::uuid4()->toString();
        $this->actorName     = $actorName;
        $this->actorRole     = $actorRole;
        $this->action        = $action;
        $this->appointmentId = $appointmentId;
        $this->resourceType  = $resourceType;
        $this->resourceId    = $resourceId;
        $this->metadata      = $metadata !== [] ? $metadata : null;
        $this->createdAt     = new DateTimeImmutable();
    }

    public function toArray(): array
    {
        return [
            'id'            => $this->id,
            'actor_name'    => $this->actorName,
            'actor_role'    => $this->actorRole,
            'action'        => $this->action,
            'appointment_id' => $this->appointmentId,
            'resource_type' => $this->resourceType,
            'resource_id'   => $this->resourceId,
            'metadata'      => $this->metadata ?? [],
            'created_at'    => $this->createdAt->format(DATE_ATOM),
        ];
    }
}
