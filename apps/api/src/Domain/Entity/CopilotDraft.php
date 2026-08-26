<?php

declare(strict_types=1);

namespace App\Domain\Entity;

use Doctrine\ORM\Mapping as ORM;
use Ramsey\Uuid\Uuid;

/**
 * An AI-generated clinical draft for a consultation — a summary, a SOAP draft and
 * extracted symptoms/medications/diagnoses derived from the transcript. One per
 * appointment (regenerating replaces it). This is ALWAYS a draft: it never becomes
 * the official record on its own; the clinician reviews it and, if they choose,
 * carries it into the SOAP note, which they then finalize.
 */
#[ORM\Entity]
#[ORM\Table(name: 'copilot_drafts')]
#[ORM\UniqueConstraint(name: 'uniq_copilot_appointment', columns: ['appointment_id'])]
#[ORM\HasLifecycleCallbacks]
class CopilotDraft
{
    use TimestampsTrait;

    #[ORM\Id]
    #[ORM\Column(type: 'uuid')]
    private string $id;

    #[ORM\Column(name: 'appointment_id', type: 'uuid')]
    private string $appointmentId;

    #[ORM\Column(type: 'text', nullable: true)]
    private ?string $summary = null;

    #[ORM\Column(type: 'text', nullable: true)]
    private ?string $subjective = null;

    #[ORM\Column(type: 'text', nullable: true)]
    private ?string $objective = null;

    #[ORM\Column(type: 'text', nullable: true)]
    private ?string $assessment = null;

    #[ORM\Column(type: 'text', nullable: true)]
    private ?string $plan = null;

    /** @var list<string> */
    #[ORM\Column(type: 'json')]
    private array $symptoms = [];

    /** @var list<string> */
    #[ORM\Column(type: 'json')]
    private array $medications = [];

    /** @var list<string> */
    #[ORM\Column(type: 'json')]
    private array $diagnoses = [];

    #[ORM\Column(name: 'follow_up', type: 'text', nullable: true)]
    private ?string $followUp = null;

    #[ORM\Column(name: 'generated_by', type: 'string', length: 200, nullable: true)]
    private ?string $generatedBy = null;

    public function __construct(string $appointmentId)
    {
        $this->id            = Uuid::uuid4()->toString();
        $this->appointmentId = $appointmentId;
    }

    private static function clean(?string $v): ?string
    {
        return $v !== null && trim($v) !== '' ? trim($v) : null;
    }

    /** @param array<string,mixed> $d */
    public function apply(array $d, string $author): void
    {
        $this->summary     = self::clean($d['summary'] ?? null);
        $this->subjective  = self::clean($d['subjective'] ?? null);
        $this->objective   = self::clean($d['objective'] ?? null);
        $this->assessment  = self::clean($d['assessment'] ?? null);
        $this->plan        = self::clean($d['plan'] ?? null);
        $this->followUp    = self::clean($d['follow_up'] ?? null);
        $this->symptoms    = self::strList($d['symptoms'] ?? []);
        $this->medications = self::strList($d['medications'] ?? []);
        $this->diagnoses   = self::strList($d['diagnoses'] ?? []);
        $this->generatedBy = $author;
    }

    /** @param mixed $v @return list<string> */
    private static function strList($v): array
    {
        return is_array($v)
            ? array_values(array_filter(array_map(
                static fn ($x): string => is_string($x) ? trim($x) : '',
                $v,
            ), static fn (string $s): bool => $s !== ''))
            : [];
    }

    public function toArray(): array
    {
        return [
            'appointment_id' => $this->appointmentId,
            'summary'        => $this->summary,
            'subjective'     => $this->subjective,
            'objective'      => $this->objective,
            'assessment'     => $this->assessment,
            'plan'           => $this->plan,
            'symptoms'       => $this->symptoms,
            'medications'    => $this->medications,
            'diagnoses'      => $this->diagnoses,
            'follow_up'      => $this->followUp,
            'generated_by'   => $this->generatedBy,
            'generated_at'   => $this->getUpdatedAt()->format(DATE_ATOM),
        ];
    }
}
