<?php

declare(strict_types=1);

namespace App\Domain\Entity;

use DateTimeImmutable;
use Doctrine\ORM\Mapping as ORM;
use Ramsey\Uuid\Uuid;

/**
 * One change of a doctor's standing — submitted, approved, sent back,
 * suspended, reinstated — with who did it and why. Append-only, like
 * {@see AuditEvent}: the back office's History tab reads these, so a rejection
 * reason or a suspension code survives the doctor resubmitting or being
 * reinstated (the specialist row only keeps the current one).
 */
#[ORM\Entity]
#[ORM\Table(name: 'specialist_status_events')]
#[ORM\Index(name: 'idx_specialist_status_events_specialist', columns: ['specialist_id'])]
class SpecialistStatusEvent
{
    #[ORM\Id]
    #[ORM\Column(type: 'uuid')]
    private string $id;

    #[ORM\Column(name: 'specialist_id', type: 'uuid')]
    private string $specialistId;

    /** The status before (null for a legacy doctor with no stored status). */
    #[ORM\Column(name: 'from_status', type: 'string', length: 20, nullable: true)]
    private ?string $fromStatus;

    #[ORM\Column(name: 'to_status', type: 'string', length: 20)]
    private string $toStatus;

    /** The staff user who made the change; null for the system (e.g. an expired licence). */
    #[ORM\Column(name: 'actor_id', type: 'uuid', nullable: true)]
    private ?string $actorId;

    #[ORM\Column(name: 'actor_name', type: 'string', length: 200)]
    private string $actorName;

    /** A machine-readable reason, e.g. a suspension code (licence_expired, conduct, …). */
    #[ORM\Column(type: 'string', length: 30, nullable: true)]
    private ?string $code;

    /** The reason given (a rejection, a suspension, a reinstatement note). */
    #[ORM\Column(type: 'text', nullable: true)]
    private ?string $reason;

    /** @var array<string,mixed>|null */
    #[ORM\Column(type: 'json', nullable: true)]
    private ?array $meta;

    #[ORM\Column(name: 'created_at', type: 'datetime_immutable')]
    private DateTimeImmutable $createdAt;

    /** @param array<string,mixed> $meta */
    public function __construct(
        string $specialistId,
        ?string $fromStatus,
        string $toStatus,
        ?string $actorId,
        string $actorName,
        ?string $reason = null,
        ?string $code = null,
        array $meta = [],
        ?DateTimeImmutable $at = null,
    ) {
        $this->id           = Uuid::uuid4()->toString();
        $this->specialistId = $specialistId;
        $this->fromStatus   = $fromStatus;
        $this->toStatus     = $toStatus;
        $this->actorId      = $actorId !== null && Uuid::isValid($actorId) ? $actorId : null;
        $this->actorName    = mb_substr(trim($actorName) !== '' ? trim($actorName) : 'System', 0, 200);
        $this->reason       = $reason !== null && trim($reason) !== '' ? trim($reason) : null;
        $this->code         = $code !== null && $code !== '' ? $code : null;
        $this->meta         = $meta !== [] ? $meta : null;
        $this->createdAt    = $at ?? new DateTimeImmutable();
    }

    public function getToStatus(): string
    {
        return $this->toStatus;
    }

    /** @return array<string,mixed> */
    public function toArray(): array
    {
        return [
            'id'          => $this->id,
            'from_status' => $this->fromStatus,
            'to_status'   => $this->toStatus,
            'actor_id'    => $this->actorId,
            'actor_name'  => $this->actorName,
            'code'        => $this->code,
            'reason'      => $this->reason,
            // Always a JSON object, `{}` when empty (never `[]`).
            'meta'        => $this->meta !== null && $this->meta !== [] ? $this->meta : new \stdClass(),
            'created_at'  => $this->createdAt->format(DATE_ATOM),
        ];
    }
}
