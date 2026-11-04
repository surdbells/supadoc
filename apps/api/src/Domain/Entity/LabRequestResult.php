<?php

declare(strict_types=1);

namespace App\Domain\Entity;

use App\Domain\Settings\ProcessClock;
use DateTimeImmutable;
use Doctrine\ORM\Mapping as ORM;
use Ramsey\Uuid\Uuid;

/**
 * A result file the patient added to a lab request (spec §1.3): the medical
 * document (a scalar id — what a doctor may see of it is the access policy's
 * call), the items it covers, what happened to its sharing at upload, whether
 * a doctor could ever open it in VideoMed, and the requesting doctor's review.
 *
 * `review_outcome` is never shown to the patient (they see the comment and
 * "Reviewed by your doctor"). The two `review_*_at` columns make the review
 * safety net's reminder and staff escalation happen once per result.
 */
#[ORM\Entity]
#[ORM\Table(name: 'lab_request_results')]
#[ORM\UniqueConstraint(name: 'uniq_lab_results_document', columns: ['document_id'])]
#[ORM\Index(name: 'idx_lab_results_request', columns: ['lab_request_id', 'uploaded_at'])]
#[ORM\Index(name: 'idx_lab_results_review_due', columns: ['reviewed_at', 'uploaded_at'])]
class LabRequestResult
{
    public const OUTCOMES = ['normal', 'abnormal'];

    public const SHARE_OUTCOMES = ['shared', 'private', 'sharing_unavailable', 'doctor_unavailable'];

    #[ORM\Id]
    #[ORM\Column(type: 'uuid')]
    private string $id;

    #[ORM\ManyToOne(targetEntity: LabRequest::class, inversedBy: 'results')]
    #[ORM\JoinColumn(name: 'lab_request_id', referencedColumnName: 'id', nullable: false, onDelete: 'RESTRICT')]
    private LabRequest $request;

    #[ORM\Column(name: 'document_id', type: 'uuid')]
    private string $documentId;

    /** @var list<string> ids of the request items this file covers */
    #[ORM\Column(name: 'item_ids', type: 'json')]
    private array $itemIds;

    #[ORM\Column(name: 'uploaded_by', type: 'string', length: 10)]
    private string $uploadedBy = 'patient';

    #[ORM\Column(name: 'uploaded_at', type: 'datetime_immutable')]
    private DateTimeImmutable $uploadedAt;

    #[ORM\Column(name: 'share_outcome', type: 'string', length: 24)]
    private string $shareOutcome = 'private';

    /** DocumentSharingRules::isViewable(ext, mime) of the stored file (immutable). */
    #[ORM\Column(type: 'boolean')]
    private bool $viewable;

    #[ORM\Column(name: 'review_outcome', type: 'string', length: 10, nullable: true)]
    private ?string $reviewOutcome = null;

    #[ORM\Column(name: 'review_comment', type: 'text', nullable: true)]
    private ?string $reviewComment = null;

    #[ORM\Column(name: 'reviewed_at', type: 'datetime_immutable', nullable: true)]
    private ?DateTimeImmutable $reviewedAt = null;

    #[ORM\Column(name: 'reviewed_by', type: 'uuid', nullable: true)]
    private ?string $reviewedBy = null;

    #[ORM\Column(name: 'review_count', type: 'smallint', options: ['default' => 0])]
    private int $reviewCount = 0;

    #[ORM\Column(name: 'review_reminded_at', type: 'datetime_immutable', nullable: true)]
    private ?DateTimeImmutable $reviewRemindedAt = null;

    #[ORM\Column(name: 'review_escalated_at', type: 'datetime_immutable', nullable: true)]
    private ?DateTimeImmutable $reviewEscalatedAt = null;

    /** @param list<string> $itemIds */
    public function __construct(LabRequest $request, string $documentId, array $itemIds, bool $viewable, DateTimeImmutable $now)
    {
        $this->id         = Uuid::uuid4()->toString();
        $this->request    = $request;
        $this->documentId = strtolower($documentId);
        $this->itemIds    = array_values(array_map('strtolower', $itemIds));
        $this->viewable   = $viewable;
        $this->uploadedAt = ProcessClock::normalize($now);
    }

    public function getId(): string
    {
        return $this->id;
    }

    public function getRequest(): LabRequest
    {
        return $this->request;
    }

    public function getDocumentId(): string
    {
        return $this->documentId;
    }

    /** @return list<string> */
    public function getItemIds(): array
    {
        return $this->itemIds;
    }

    public function getUploadedBy(): string
    {
        return $this->uploadedBy;
    }

    public function getUploadedAt(): DateTimeImmutable
    {
        return $this->uploadedAt;
    }

    public function getShareOutcome(): string
    {
        return $this->shareOutcome;
    }

    public function setShareOutcome(string $outcome): void
    {
        $this->shareOutcome = in_array($outcome, self::SHARE_OUTCOMES, true) ? $outcome : 'private';
    }

    public function isViewable(): bool
    {
        return $this->viewable;
    }

    public function getReviewOutcome(): ?string
    {
        return $this->reviewOutcome;
    }

    public function getReviewComment(): ?string
    {
        return $this->reviewComment;
    }

    public function getReviewedAt(): ?DateTimeImmutable
    {
        return $this->reviewedAt;
    }

    public function getReviewedBy(): ?string
    {
        return $this->reviewedBy;
    }

    public function getReviewCount(): int
    {
        return $this->reviewCount;
    }

    public function isReviewed(): bool
    {
        return $this->reviewedAt !== null;
    }

    /** Save (or change) the review; true when it changed an earlier one. */
    public function review(string $outcome, ?string $comment, string $reviewerId, DateTimeImmutable $now): bool
    {
        $changed             = $this->reviewedAt !== null;
        $this->reviewOutcome = $outcome;
        $this->reviewComment = $comment;
        $this->reviewedAt    = ProcessClock::normalize($now);
        $this->reviewedBy    = strtolower($reviewerId);
        ++$this->reviewCount;

        return $changed;
    }

    public function getReviewRemindedAt(): ?DateTimeImmutable
    {
        return $this->reviewRemindedAt;
    }

    public function getReviewEscalatedAt(): ?DateTimeImmutable
    {
        return $this->reviewEscalatedAt;
    }

    public function markReviewReminded(DateTimeImmutable $now): void
    {
        $this->reviewRemindedAt = ProcessClock::normalize($now);
    }

    public function markReviewEscalated(DateTimeImmutable $now): void
    {
        $this->reviewEscalatedAt = ProcessClock::normalize($now);
    }
}
