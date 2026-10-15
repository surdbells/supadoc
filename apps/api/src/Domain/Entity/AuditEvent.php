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
 *
 * `actor_id` is the user who acted (a staff user or patient id) when known —
 * NULL for the system and for events recorded before it existed. A resource's
 * history (e.g. everything done to one doctor) is read by (resource_type,
 * resource_id), which is indexed.
 */
#[ORM\Entity]
#[ORM\Table(name: 'audit_events')]
#[ORM\Index(name: 'idx_audit_appointment', columns: ['appointment_id'])]
#[ORM\Index(name: 'idx_audit_action', columns: ['action'])]
#[ORM\Index(name: 'idx_audit_resource', columns: ['resource_type', 'resource_id'])]
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

    /** The acting user's id (staff user or patient), or null for the system / older events. */
    #[ORM\Column(name: 'actor_id', type: 'uuid', nullable: true)]
    private ?string $actorId;

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
        ?string $actorId = null,
    ) {
        $this->id            = Uuid::uuid4()->toString();
        $this->actorName     = $actorName;
        $this->actorRole     = $actorRole;
        $this->actorId       = $actorId !== null && Uuid::isValid($actorId) ? $actorId : null;
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
            'actor_id'      => $this->actorId,
            'action'        => $this->action,
            'appointment_id' => $this->appointmentId,
            'resource_type' => $this->resourceType,
            'resource_id'   => $this->resourceId,
            'metadata'      => $this->metadata ?? [],
            'created_at'    => $this->createdAt->format(DATE_ATOM),
        ];
    }
}
