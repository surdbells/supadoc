<?php

declare(strict_types=1);

namespace App\Domain\Entity;

use DateTimeImmutable;
use Doctrine\ORM\Mapping as ORM;
use Ramsey\Uuid\Uuid;

/**
 * A medical certificate issued during a consultation — a sick-leave note, a
 * fitness statement, or a general certificate. Issued signed by the doctor and
 * visible to the patient; rendered as a printable letterhead document.
 */
#[ORM\Entity]
#[ORM\Table(name: 'medical_certificates')]
#[ORM\Index(name: 'idx_medcerts_appointment', columns: ['appointment_id'])]
#[ORM\HasLifecycleCallbacks]
class MedicalCertificate
{
    use TimestampsTrait;

    public const TYPES = ['sick_leave', 'fitness', 'general'];

    #[ORM\Id]
    #[ORM\Column(type: 'uuid')]
    private string $id;

    #[ORM\Column(name: 'appointment_id', type: 'uuid')]
    private string $appointmentId;

    #[ORM\Column(name: 'patient_id', type: 'uuid')]
    private string $patientId;

    #[ORM\Column(name: 'certificate_type', type: 'string', length: 20)]
    private string $type = 'sick_leave';

    /** Optional diagnosis; a doctor may omit it for privacy. */
    #[ORM\Column(type: 'text', nullable: true)]
    private ?string $diagnosis = null;

    /** The certifying statement / recommendation shown as the body. */
    #[ORM\Column(type: 'text')]
    private string $statement = '';

    /** Rest / cover period (sick-leave certificates). */
    #[ORM\Column(name: 'from_date', type: 'date_immutable', nullable: true)]
    private ?DateTimeImmutable $fromDate = null;

    #[ORM\Column(name: 'to_date', type: 'date_immutable', nullable: true)]
    private ?DateTimeImmutable $toDate = null;

    #[ORM\Column(name: 'author_name', type: 'string', length: 200, nullable: true)]
    private ?string $authorName = null;

    public function __construct(string $appointmentId, string $patientId)
    {
        $this->id            = Uuid::uuid4()->toString();
        $this->appointmentId = $appointmentId;
        $this->patientId     = $patientId;
    }

    public function getId(): string
    {
        return $this->id;
    }

    public function getAppointmentId(): string
    {
        return $this->appointmentId;
    }

    public function setType(string $type): void
    {
        $this->type = in_array($type, self::TYPES, true) ? $type : 'general';
    }

    public function setDiagnosis(?string $v): void
    {
        $this->diagnosis = $v !== null && trim($v) !== '' ? trim($v) : null;
    }

    public function setStatement(string $v): void
    {
        $this->statement = trim($v);
    }

    public function getStatement(): string
    {
        return $this->statement;
    }

    public function setPeriod(?DateTimeImmutable $from, ?DateTimeImmutable $to): void
    {
        $this->fromDate = $from;
        $this->toDate   = $to;
    }

    public function setAuthor(string $author): void
    {
        $this->authorName = $author;
    }

    /** Whole days covered by a sick-leave period (inclusive), or null. */
    public function days(): ?int
    {
        if ($this->fromDate === null || $this->toDate === null) {
            return null;
        }

        return (int) $this->fromDate->diff($this->toDate)->days + 1;
    }

    public function typeLabel(): string
    {
        return match ($this->type) {
            'sick_leave' => 'Sick leave certificate',
            'fitness'    => 'Certificate of fitness',
            default      => 'Medical certificate',
        };
    }

    /** @return array<string,mixed> */
    public function toArray(): array
    {
        return [
            'id'             => $this->id,
            'appointment_id' => $this->appointmentId,
            'type'           => $this->type,
            'type_label'     => $this->typeLabel(),
            'diagnosis'      => $this->diagnosis,
            'statement'      => $this->statement,
            'from_date'      => $this->fromDate?->format('Y-m-d'),
            'to_date'        => $this->toDate?->format('Y-m-d'),
            'days'           => $this->days(),
            'author'         => $this->authorName,
            'created_at'     => $this->getCreatedAt()->format(DATE_ATOM),
        ];
    }
}
