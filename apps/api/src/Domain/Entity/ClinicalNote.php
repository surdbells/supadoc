<?php

declare(strict_types=1);

namespace App\Domain\Entity;

use DateTimeImmutable;
use Doctrine\ORM\Mapping as ORM;

/**
 * The clinician's SOAP note for a consultation — one per appointment. A note is a
 * `draft` while the doctor documents the visit, then `finalized` (signed + locked)
 * at the end. A finalized note is never silently overwritten: an edit records the
 * prior content in {@see $amendments}, giving an auditable history (ARCHITECTURE
 * §clinical-notes). The patient only ever sees a finalized note.
 */
#[ORM\Entity]
#[ORM\Table(name: 'clinical_notes')]
#[ORM\UniqueConstraint(name: 'uniq_clinical_notes_appointment', columns: ['appointment_id'])]
#[ORM\HasLifecycleCallbacks]
class ClinicalNote
{
    use TimestampsTrait;

    public const STATUS_DRAFT     = 'draft';
    public const STATUS_FINALIZED = 'finalized';

    #[ORM\Id]
    #[ORM\Column(type: 'uuid')]
    private string $id;

    #[ORM\Column(name: 'appointment_id', type: 'uuid')]
    private string $appointmentId;

    #[ORM\Column(type: 'text', nullable: true)]
    private ?string $subjective = null;

    #[ORM\Column(type: 'text', nullable: true)]
    private ?string $objective = null;

    #[ORM\Column(type: 'text', nullable: true)]
    private ?string $assessment = null;

    #[ORM\Column(type: 'text', nullable: true)]
    private ?string $plan = null;

    #[ORM\Column(type: 'string', length: 20, options: ['default' => self::STATUS_DRAFT])]
    private string $status = self::STATUS_DRAFT;

    #[ORM\Column(name: 'finalized_at', type: 'datetime_immutable', nullable: true)]
    private ?DateTimeImmutable $finalizedAt = null;

    /** The clinician who signed the note (name captured at finalize time). */
    #[ORM\Column(name: 'author_name', type: 'string', length: 200, nullable: true)]
    private ?string $authorName = null;

    /**
     * Audit history of post-finalize edits, newest last: each entry is the content
     * as it stood before the amendment, plus who changed it and when.
     *
     * @var list<array{at:string,author:string,previous:array<string,?string>}>|null
     */
    #[ORM\Column(type: 'json', nullable: true)]
    private ?array $amendments = null;

    public function __construct(string $appointmentId)
    {
        $this->id            = \Ramsey\Uuid\Uuid::uuid4()->toString();
        $this->appointmentId = $appointmentId;
    }

    public function getId(): string
    {
        return $this->id;
    }

    public function getAppointmentId(): string
    {
        return $this->appointmentId;
    }

    public function isFinalized(): bool
    {
        return $this->status === self::STATUS_FINALIZED;
    }

    /** The four SOAP fields as they stand — used to snapshot before an amendment. */
    private function snapshot(): array
    {
        return [
            'subjective' => $this->subjective,
            'objective'  => $this->objective,
            'assessment' => $this->assessment,
            'plan'       => $this->plan,
        ];
    }

    private static function clean(?string $v): ?string
    {
        return $v !== null && trim($v) !== '' ? trim($v) : null;
    }

    /** Overwrite the draft content. Callers guard against writing a finalized note. */
    public function applyDraft(?string $subjective, ?string $objective, ?string $assessment, ?string $plan): void
    {
        $this->subjective = self::clean($subjective);
        $this->objective  = self::clean($objective);
        $this->assessment = self::clean($assessment);
        $this->plan       = self::clean($plan);
    }

    /** Edit a finalized note: record the prior version, then apply the new content. */
    public function amend(string $author, ?string $subjective, ?string $objective, ?string $assessment, ?string $plan): void
    {
        $this->amendments ??= [];
        $this->amendments[] = [
            'at'       => (new DateTimeImmutable())->format(DATE_ATOM),
            'author'   => $author,
            'previous' => $this->snapshot(),
        ];
        $this->applyDraft($subjective, $objective, $assessment, $plan);
    }

    public function finalize(string $author): void
    {
        $this->status      = self::STATUS_FINALIZED;
        $this->finalizedAt = new DateTimeImmutable();
        $this->authorName  = $author;
    }

    /** Full view for the clinician (draft or finalized), including audit history. */
    public function toArray(): array
    {
        return [
            'appointment_id' => $this->appointmentId,
            'subjective'     => $this->subjective,
            'objective'      => $this->objective,
            'assessment'     => $this->assessment,
            'plan'           => $this->plan,
            'status'         => $this->status,
            'finalized_at'   => $this->finalizedAt?->format(DATE_ATOM),
            'author'         => $this->authorName,
            'amendments'     => $this->amendments ?? [],
            'updated_at'     => $this->getUpdatedAt()->format(DATE_ATOM),
        ];
    }

    /**
     * Patient-safe view — returned only when the note is finalized. The patient
     * sees the visit summary and plan, not the raw objective/exam field.
     */
    public function toPatientSummary(): array
    {
        return [
            'available'    => true,
            'subjective'   => $this->subjective,
            'assessment'   => $this->assessment,
            'plan'         => $this->plan,
            'finalized_at' => $this->finalizedAt?->format(DATE_ATOM),
            'author'       => $this->authorName,
        ];
    }
}
