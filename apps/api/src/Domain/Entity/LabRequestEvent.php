<?php

declare(strict_types=1);

namespace App\Domain\Entity;

use App\Domain\Settings\ProcessClock;
use DateTimeImmutable;
use Doctrine\ORM\Mapping as ORM;
use Ramsey\Uuid\Uuid;

/**
 * One step of a lab request's timeline (spec §1.4) — append-only: who did
 * what, when. `details` holds non-PHI facts only (`result_id`,
 * `consent_version`, `reason_given`, a C1 `sample_date` …); a staff
 * correction's reason is PHI and lives in `staff_note`, which is never
 * serialised to doctors or patients, never logged and never put in audit
 * metadata.
 */
#[ORM\Entity]
#[ORM\Table(name: 'lab_request_events')]
#[ORM\Index(name: 'idx_lab_events_request', columns: ['lab_request_id', 'created_at'])]
class LabRequestEvent
{
    public const EVENTS = ['sent', 'accepted', 'declined', 'sample_given', 'result_added', 'result_reviewed', 'cancelled', 'expired', 'reminded', 'status_corrected'];

    /** How a staff correction is signed on the timeline (the staff email lives in the audit row only). */
    public const STAFF_NAME = 'VideoMed support';

    #[ORM\Id]
    #[ORM\Column(type: 'uuid')]
    private string $id;

    #[ORM\Column(name: 'lab_request_id', type: 'uuid')]
    private string $labRequestId;

    #[ORM\Column(type: 'string', length: 32)]
    private string $event;

    #[ORM\Column(name: 'from_status', type: 'string', length: 20, nullable: true)]
    private ?string $fromStatus;

    #[ORM\Column(name: 'to_status', type: 'string', length: 20, nullable: true)]
    private ?string $toStatus;

    #[ORM\Column(name: 'actor_role', type: 'string', length: 10)]
    private string $actorRole;

    #[ORM\Column(name: 'actor_id', type: 'uuid', nullable: true)]
    private ?string $actorId;

    #[ORM\Column(name: 'actor_name', type: 'string', length: 200, nullable: true)]
    private ?string $actorName;

    /** @var array<string,mixed>|null */
    #[ORM\Column(type: 'json', nullable: true)]
    private ?array $details;

    #[ORM\Column(name: 'staff_note', type: 'text', nullable: true)]
    private ?string $staffNote;

    #[ORM\Column(name: 'created_at', type: 'datetime_immutable')]
    private DateTimeImmutable $createdAt;

    /** @param array<string,mixed>|null $details */
    public function __construct(
        string $labRequestId,
        string $event,
        ?string $fromStatus,
        ?string $toStatus,
        string $actorRole,
        ?string $actorId,
        ?string $actorName,
        ?array $details,
        DateTimeImmutable $at,
        ?string $staffNote = null,
    ) {
        $this->id           = Uuid::uuid4()->toString();
        $this->labRequestId = strtolower($labRequestId);
        $this->event        = $event;
        $this->fromStatus   = $fromStatus;
        $this->toStatus     = $toStatus;
        $this->actorRole    = $actorRole;
        $this->actorId      = $actorId !== null && $actorId !== '' ? strtolower($actorId) : null;
        $this->actorName    = $actorName !== null ? mb_substr($actorName, 0, 200) : null;
        $this->details      = $details !== [] ? $details : null;
        $this->staffNote    = $staffNote;
        $this->createdAt    = ProcessClock::normalize($at);
    }

    public function getId(): string
    {
        return $this->id;
    }

    public function getLabRequestId(): string
    {
        return $this->labRequestId;
    }

    public function getEvent(): string
    {
        return $this->event;
    }

    public function getFromStatus(): ?string
    {
        return $this->fromStatus;
    }

    public function getToStatus(): ?string
    {
        return $this->toStatus;
    }

    public function getActorRole(): string
    {
        return $this->actorRole;
    }

    public function getActorId(): ?string
    {
        return $this->actorId;
    }

    public function getActorName(): ?string
    {
        return $this->actorName;
    }

    /** @return array<string,mixed> */
    public function getDetails(): array
    {
        return $this->details ?? [];
    }

    public function getStaffNote(): ?string
    {
        return $this->staffNote;
    }

    public function getCreatedAt(): DateTimeImmutable
    {
        return $this->createdAt;
    }
}
