<?php

declare(strict_types=1);

namespace App\Domain\Entity;

use DateTimeImmutable;
use Doctrine\ORM\Mapping as ORM;
use Ramsey\Uuid\Uuid;

/**
 * One thing that happened to a submitted application (spec §2.4), append-only:
 * every status change, each item an applicant updated, each email / SMS sent.
 * The applicant sees the status changes only (`applicant_visible`). Metadata
 * is PHI-free: ids, slot / section keys, the channel and the template.
 * There are no events before submit.
 */
#[ORM\Entity]
#[ORM\Table(name: 'doctor_application_events')]
#[ORM\Index(name: 'idx_doc_app_events_app_created', columns: ['application_id', 'created_at'])]
class DoctorApplicationEvent
{
    public const KINDS = [
        'submitted', 'review_started', 'info_requested', 'info_item_updated', 'applicant_replied',
        'interview_scheduled', 'interview_rescheduled', 'interview_cancelled', 'interview_resent',
        'approved', 'rejected', 'withdrawn', 'specialist_created', 'email_sent', 'sms_sent', 'notification_failed',
    ];

    /** kind => the back office's words. */
    public const LABELS = [
        'submitted'             => 'Application submitted',
        'review_started'        => 'Review started',
        'info_requested'        => 'More information requested',
        'info_item_updated'     => 'Applicant updated an item',
        'applicant_replied'     => 'Applicant sent the requested items',
        'interview_scheduled'   => 'Interview scheduled',
        'interview_rescheduled' => 'Interview rescheduled',
        'interview_cancelled'   => 'Interview cancelled',
        'interview_resent'      => 'Interview details sent again',
        'approved'              => 'Approved',
        'rejected'              => 'Rejected',
        'withdrawn'             => 'Withdrawn by the applicant',
        'specialist_created'    => 'Doctor profile created',
        'email_sent'            => 'Email sent',
        'sms_sent'              => 'SMS sent',
        'notification_failed'   => 'Notification failed',
    ];

    #[ORM\Id]
    #[ORM\Column(type: 'uuid')]
    private string $id;

    #[ORM\Column(name: 'application_id', type: 'uuid')]
    private string $applicationId;

    #[ORM\Column(type: 'string', length: 40)]
    private string $kind;

    #[ORM\Column(name: 'from_status', type: 'string', length: 24, nullable: true)]
    private ?string $fromStatus;

    #[ORM\Column(name: 'to_status', type: 'string', length: 24, nullable: true)]
    private ?string $toStatus;

    /** applicant | staff | system */
    #[ORM\Column(name: 'actor_type', type: 'string', length: 12)]
    private string $actorType;

    #[ORM\Column(name: 'actor_id', type: 'uuid', nullable: true)]
    private ?string $actorId;

    #[ORM\Column(name: 'actor_name', type: 'string', length: 200, nullable: true)]
    private ?string $actorName;

    #[ORM\Column(name: 'applicant_visible', type: 'boolean')]
    private bool $applicantVisible;

    /** The info request's message, the reject reason or the interview note. */
    #[ORM\Column(name: 'public_message', type: 'text', nullable: true)]
    private ?string $publicMessage;

    /** @var array<string,mixed>|null */
    #[ORM\Column(type: 'json', nullable: true)]
    private ?array $metadata;

    #[ORM\Column(name: 'created_at', type: 'datetime_immutable')]
    private DateTimeImmutable $createdAt;

    /** @param array<string,mixed> $metadata */
    public function __construct(
        string $applicationId,
        string $kind,
        string $actorType,
        ?string $fromStatus = null,
        ?string $toStatus = null,
        ?string $actorId = null,
        ?string $actorName = null,
        bool $applicantVisible = false,
        ?string $publicMessage = null,
        array $metadata = [],
        ?DateTimeImmutable $at = null,
    ) {
        $this->id               = Uuid::uuid4()->toString();
        $this->applicationId    = $applicationId;
        $this->kind             = $kind;
        $this->actorType        = in_array($actorType, ['applicant', 'staff', 'system'], true) ? $actorType : 'system';
        $this->fromStatus       = $fromStatus;
        $this->toStatus         = $toStatus;
        $this->actorId          = $actorId !== null && Uuid::isValid($actorId) ? $actorId : null;
        $this->actorName        = $actorName !== null && trim($actorName) !== '' ? mb_substr(trim($actorName), 0, 200) : null;
        $this->applicantVisible = $applicantVisible;
        $this->publicMessage    = $publicMessage !== null && trim($publicMessage) !== '' ? $publicMessage : null;
        $this->metadata         = $metadata !== [] ? $metadata : null;
        $this->createdAt        = $at ?? new DateTimeImmutable();
    }

    public function getId(): string
    {
        return $this->id;
    }

    public function getApplicationId(): string
    {
        return $this->applicationId;
    }

    public function getKind(): string
    {
        return $this->kind;
    }

    public function getFromStatus(): ?string
    {
        return $this->fromStatus;
    }

    public function getToStatus(): ?string
    {
        return $this->toStatus;
    }

    public function getActorType(): string
    {
        return $this->actorType;
    }

    public function getActorName(): ?string
    {
        return $this->actorName;
    }

    public function isApplicantVisible(): bool
    {
        return $this->applicantVisible;
    }

    public function getPublicMessage(): ?string
    {
        return $this->publicMessage;
    }

    /** @return array<string,mixed> */
    public function getMetadata(): array
    {
        return $this->metadata ?? [];
    }

    public function getCreatedAt(): DateTimeImmutable
    {
        return $this->createdAt;
    }

    /** DoctorApplicationEventDto (staff). @return array<string,mixed> */
    public function toArray(): array
    {
        $channel = $this->metadata['channel'] ?? null;

        return [
            'id'                => $this->id,
            'kind'              => $this->kind,
            'label'             => self::LABELS[$this->kind] ?? ucfirst(str_replace('_', ' ', $this->kind)),
            'from_status'       => $this->fromStatus,
            'to_status'         => $this->toStatus,
            'actor_type'        => $this->actorType,
            'actor_name'        => $this->actorName,
            'applicant_visible' => $this->applicantVisible,
            'public_message'    => $this->publicMessage,
            'channel'           => in_array($channel, ['sms', 'email'], true) ? $channel : null,
            'created_at'        => $this->createdAt->format(DATE_ATOM),
        ];
    }
}
