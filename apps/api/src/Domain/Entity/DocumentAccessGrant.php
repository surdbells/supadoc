<?php

declare(strict_types=1);

namespace App\Domain\Entity;

use DateTimeImmutable;
use Doctrine\Common\Collections\ArrayCollection;
use Doctrine\Common\Collections\Collection;
use Doctrine\ORM\Mapping as ORM;

/**
 * A patient letting one doctor (the SPECIALIST, never a user row) see their
 * documents for the window [starts_at, expires_at) — `expires_at` NULL = no
 * end (spec §1.1, §1.3). Scope `all` = the whole folder, including files added
 * while it lasts, minus documents hidden from that doctor
 * ({@see DocumentAccessHidden}); `selected` = only the documents on its include
 * rows ({@see DocumentAccessGrantDocument}).
 *
 * Grants are never deleted. `status` is bookkeeping (active | expired |
 * revoked): {@see \App\Infrastructure\Document\DocumentAccessPolicy} always
 * checks the window too. Every state change is a compare-and-set statement
 * ({@see \App\Infrastructure\Document\DocumentAccessTransitions}), so rows are
 * written with DBAL and this class only maps the table for the schema tool.
 *
 * Partial unique backstops (RawIndexes): one active folder grant per pair;
 * one active grant per (pair, client_key).
 */
#[ORM\Entity]
#[ORM\Table(name: 'document_access_grants')]
#[ORM\Index(name: 'idx_doc_grants_pair', columns: ['patient_id', 'specialist_id', 'status'])]
#[ORM\Index(name: 'idx_doc_grants_specialist', columns: ['specialist_id', 'status'])]
#[ORM\Index(name: 'idx_doc_grants_appointment', columns: ['appointment_id'])]
#[ORM\Index(name: 'idx_doc_grants_due', columns: ['status', 'expires_at'])]
#[ORM\Index(name: 'idx_doc_grants_client_key', columns: ['patient_id', 'client_key'])]
#[ORM\Index(name: 'idx_doc_grants_revoke_batch', columns: ['patient_id', 'revoke_batch_id'])]
#[ORM\HasLifecycleCallbacks]
class DocumentAccessGrant
{
    use TimestampsTrait;

    public const SCOPE_ALL      = 'all';
    public const SCOPE_SELECTED = 'selected';

    public const STATUS_ACTIVE  = 'active';
    public const STATUS_EXPIRED = 'expired';
    public const STATUS_REVOKED = 'revoked';

    public const SOURCES     = ['share', 'upload', 'booking', 'request', 'restore'];
    public const END_REASONS = ['revoked', 'expired', 'appointment_cancelled', 'emptied', 'merged', 'account_closed', 'doctor_unavailable'];

    #[ORM\Id]
    #[ORM\Column(type: 'uuid')]
    private string $id;

    #[ORM\ManyToOne(targetEntity: Patient::class)]
    #[ORM\JoinColumn(name: 'patient_id', referencedColumnName: 'id', nullable: false, onDelete: 'RESTRICT')]
    private Patient $patient;

    #[ORM\ManyToOne(targetEntity: Specialist::class)]
    #[ORM\JoinColumn(name: 'specialist_id', referencedColumnName: 'id', nullable: false, onDelete: 'RESTRICT')]
    private Specialist $specialist;

    /** all | selected */
    #[ORM\Column(name: 'scope', type: 'string', length: 10)]
    private string $scope;

    /** active | expired | revoked */
    #[ORM\Column(name: 'status', type: 'string', length: 10, options: ['default' => 'active'])]
    private string $status = self::STATUS_ACTIVE;

    /** share | upload | booking | request | restore */
    #[ORM\Column(name: 'source', type: 'string', length: 10)]
    private string $source;

    /** Where the patient decided (documents_page, manage_sharing, …, request, restore). */
    #[ORM\Column(name: 'surface', type: 'string', length: 24)]
    private string $surface;

    /** The review copy the patient saw ({@see \App\Domain\Document\DocumentSharingRules::CONSENT_VERSION}). */
    #[ORM\Column(name: 'consent_version', type: 'string', length: 20)]
    private string $consentVersion;

    /** {@see \App\Domain\Document\ShareDuration} code. */
    #[ORM\Column(name: 'duration', type: 'string', length: 12)]
    private string $duration;

    #[ORM\Column(name: 'starts_at', type: 'datetime_immutable')]
    private DateTimeImmutable $startsAt;

    /** Exclusive end; NULL = no end. */
    #[ORM\Column(name: 'expires_at', type: 'datetime_immutable', nullable: true)]
    private ?DateTimeImmutable $expiresAt = null;

    /** The end at creation or at the patient's last change: the base of the reschedule cap. */
    #[ORM\Column(name: 'original_expires_at', type: 'datetime_immutable', nullable: true)]
    private ?DateTimeImmutable $originalExpiresAt = null;

    /** The consultation an `after_*` share is anchored to (always validated when set). */
    #[ORM\ManyToOne(targetEntity: Appointment::class)]
    #[ORM\JoinColumn(name: 'appointment_id', referencedColumnName: 'id', nullable: true, onDelete: 'SET NULL')]
    private ?Appointment $appointment = null;

    /** The doctor's request this share answered. */
    #[ORM\ManyToOne(targetEntity: DocumentAccessRequest::class)]
    #[ORM\JoinColumn(name: 'request_id', referencedColumnName: 'id', nullable: true, onDelete: 'SET NULL')]
    private ?DocumentAccessRequest $request = null;

    /** Idempotency / upload batch key (one per dialog submission or upload batch). */
    #[ORM\Column(name: 'client_key', type: 'string', length: 36, nullable: true)]
    private ?string $clientKey = null;

    /** sha256 of the canonical request ({@see \App\Domain\Document\DocumentSharingRules::requestHash()}). */
    #[ORM\Column(name: 'request_hash', type: 'string', length: 64, nullable: true, options: ['fixed' => true])]
    private ?string $requestHash = null;

    /** Set on every grant one patient revoke ended together (Undo). */
    #[ORM\Column(name: 'revoke_batch_id', type: 'uuid', nullable: true)]
    private ?string $revokeBatchId = null;

    /** When an Undo restored this ended grant (compare-and-set). */
    #[ORM\Column(name: 'restored_at', type: 'datetime_immutable', nullable: true)]
    private ?DateTimeImmutable $restoredAt = null;

    #[ORM\Column(name: 'restored_from_grant_id', type: 'uuid', nullable: true)]
    private ?string $restoredFromGrantId = null;

    #[ORM\Column(name: 'ended_at', type: 'datetime_immutable', nullable: true)]
    private ?DateTimeImmutable $endedAt = null;

    #[ORM\Column(name: 'end_reason', type: 'string', length: 24, nullable: true)]
    private ?string $endReason = null;

    /** patient | system */
    #[ORM\Column(name: 'ended_by', type: 'string', length: 10, nullable: true)]
    private ?string $endedBy = null;

    #[ORM\Column(name: 'last_accessed_at', type: 'datetime_immutable', nullable: true)]
    private ?DateTimeImmutable $lastAccessedAt = null;

    #[ORM\Column(name: 'access_count', type: 'integer', options: ['default' => 0])]
    private int $accessCount = 0;

    /** @var Collection<int, DocumentAccessGrantDocument> */
    #[ORM\OneToMany(targetEntity: DocumentAccessGrantDocument::class, mappedBy: 'grant')]
    private Collection $documents;

    private function __construct()
    {
        $this->documents = new ArrayCollection();
    }

    public function getId(): string
    {
        return $this->id;
    }

    public function getStatus(): string
    {
        return $this->status;
    }

    public function getScope(): string
    {
        return $this->scope;
    }

    public function getExpiresAt(): ?DateTimeImmutable
    {
        return $this->expiresAt;
    }
}
