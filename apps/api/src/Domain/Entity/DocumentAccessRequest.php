<?php

declare(strict_types=1);

namespace App\Domain\Entity;

use DateTimeImmutable;
use Doctrine\ORM\Mapping as ORM;

/**
 * A doctor asking a patient to share documents, from one of their
 * consultations (spec §1.1, §1.3). Kind `access`, or `extend` while the doctor
 * holds a whole-folder share ending within 48 hours. Pending for 7 days; the
 * patient approves (a grant, source `request`) or declines (optionally
 * blocking further requests). Never deleted; one pending request per pair is
 * a partial unique index (RawIndexes). State changes are compare-and-set
 * ({@see \App\Infrastructure\Document\DocumentAccessTransitions}).
 *
 * The doctor's `message` is shown in the patient app only — never in a
 * notification, an email or the audit trail.
 */
#[ORM\Entity]
#[ORM\Table(name: 'document_access_requests')]
#[ORM\Index(name: 'idx_doc_requests_patient', columns: ['patient_id', 'status', 'created_at'])]
#[ORM\Index(name: 'idx_doc_requests_specialist', columns: ['specialist_id', 'created_at'])]
#[ORM\Index(name: 'idx_doc_requests_due', columns: ['status', 'expires_at'])]
#[ORM\HasLifecycleCallbacks]
class DocumentAccessRequest
{
    use TimestampsTrait;

    public const STATUSES      = ['pending', 'approved', 'declined', 'cancelled', 'expired'];
    public const CLOSE_REASONS = ['approved', 'shared_directly', 'declined', 'withdrawn', 'expired', 'doctor_unavailable', 'not_eligible', 'account_closed'];

    #[ORM\Id]
    #[ORM\Column(type: 'uuid')]
    private string $id;

    #[ORM\ManyToOne(targetEntity: Patient::class)]
    #[ORM\JoinColumn(name: 'patient_id', referencedColumnName: 'id', nullable: false, onDelete: 'RESTRICT')]
    private Patient $patient;

    #[ORM\ManyToOne(targetEntity: Specialist::class)]
    #[ORM\JoinColumn(name: 'specialist_id', referencedColumnName: 'id', nullable: false, onDelete: 'RESTRICT')]
    private Specialist $specialist;

    #[ORM\ManyToOne(targetEntity: Appointment::class)]
    #[ORM\JoinColumn(name: 'appointment_id', referencedColumnName: 'id', nullable: true, onDelete: 'SET NULL')]
    private ?Appointment $appointment = null;

    /** The doctor login that asked. */
    #[ORM\Column(name: 'requested_by_user_id', type: 'uuid', nullable: true)]
    private ?string $requestedByUserId = null;

    /** access | extend */
    #[ORM\Column(name: 'kind', type: 'string', length: 10, options: ['default' => 'access'])]
    private string $kind = 'access';

    /** pending | approved | declined | cancelled | expired */
    #[ORM\Column(name: 'status', type: 'string', length: 10, options: ['default' => 'pending'])]
    private string $status = 'pending';

    /** Sanitised plain text; patient app only. */
    #[ORM\Column(name: 'message', type: 'text', nullable: true)]
    private ?string $message = null;

    #[ORM\Column(name: 'expires_at', type: 'datetime_immutable')]
    private DateTimeImmutable $expiresAt;

    #[ORM\Column(name: 'decided_at', type: 'datetime_immutable', nullable: true)]
    private ?DateTimeImmutable $decidedAt = null;

    #[ORM\Column(name: 'close_reason', type: 'string', length: 24, nullable: true)]
    private ?string $closeReason = null;

    private function __construct()
    {
    }

    public function getId(): string
    {
        return $this->id;
    }

    public function getStatus(): string
    {
        return $this->status;
    }
}
