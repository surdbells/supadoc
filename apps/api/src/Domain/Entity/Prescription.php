<?php

declare(strict_types=1);

namespace App\Domain\Entity;

use DateTimeImmutable;
use Doctrine\ORM\Mapping as ORM;
use Ramsey\Uuid\Uuid;

/**
 * An e-prescription issued during a consultation. Holds one or more medication
 * line items. A prescription is `draft` while the doctor builds it and `signed`
 * once issued — only signed prescriptions are visible to the patient. A signed
 * prescription is never edited (issue a new one instead).
 */
#[ORM\Entity]
#[ORM\Table(name: 'prescriptions')]
#[ORM\Index(name: 'idx_prescriptions_appointment', columns: ['appointment_id'])]
#[ORM\HasLifecycleCallbacks]
class Prescription
{
    use TimestampsTrait;

    public const STATUS_DRAFT  = 'draft';
    public const STATUS_SIGNED = 'signed';

    #[ORM\Id]
    #[ORM\Column(type: 'uuid')]
    private string $id;

    #[ORM\Column(name: 'appointment_id', type: 'uuid')]
    private string $appointmentId;

    #[ORM\Column(name: 'patient_id', type: 'uuid')]
    private string $patientId;

    /**
     * Medication line items.
     *
     * @var list<array<string,string>>
     */
    #[ORM\Column(type: 'json')]
    private array $items = [];

    #[ORM\Column(type: 'text', nullable: true)]
    private ?string $notes = null;

    #[ORM\Column(type: 'string', length: 20, options: ['default' => self::STATUS_DRAFT])]
    private string $status = self::STATUS_DRAFT;

    #[ORM\Column(name: 'signed_at', type: 'datetime_immutable', nullable: true)]
    private ?DateTimeImmutable $signedAt = null;

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

    public function isSigned(): bool
    {
        return $this->status === self::STATUS_SIGNED;
    }

    /**
     * Normalises and stores the medication items, keeping only the known fields
     * and dropping rows without a medication name.
     *
     * @param list<array<string,mixed>> $items
     */
    public function setItems(array $items): void
    {
        $fields = ['medication', 'strength', 'dosage', 'frequency', 'route', 'duration', 'quantity', 'instructions', 'refills'];
        $clean  = [];
        foreach ($items as $row) {
            if (!is_array($row)) {
                continue;
            }
            $medication = trim((string) ($row['medication'] ?? ''));
            if ($medication === '') {
                continue;
            }
            $line = [];
            foreach ($fields as $f) {
                $line[$f] = trim((string) ($row[$f] ?? ''));
            }
            $clean[] = $line;
        }
        $this->items = $clean;
    }

    /** @return list<array<string,string>> */
    public function getItems(): array
    {
        return $this->items;
    }

    public function setNotes(?string $notes): void
    {
        $this->notes = $notes !== null && trim($notes) !== '' ? trim($notes) : null;
    }

    public function sign(string $author): void
    {
        $this->status     = self::STATUS_SIGNED;
        $this->signedAt   = new DateTimeImmutable();
        $this->authorName = $author;
    }

    public function toArray(): array
    {
        return [
            'id'             => $this->id,
            'appointment_id' => $this->appointmentId,
            'items'          => $this->items,
            'notes'          => $this->notes,
            'status'         => $this->status,
            'signed_at'      => $this->signedAt?->format(DATE_ATOM),
            'author'         => $this->authorName,
            'created_at'     => $this->getCreatedAt()->format(DATE_ATOM),
        ];
    }
}
