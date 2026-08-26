<?php

declare(strict_types=1);

namespace App\Domain\Entity;

use DateTimeImmutable;
use Doctrine\ORM\Mapping as ORM;
use Ramsey\Uuid\Uuid;

/**
 * A consent decision for a consultation (recording, AI transcription, data
 * sharing). One row per (appointment, type) — the latest decision. Every change
 * is also written to the audit trail, so the history is preserved there.
 */
#[ORM\Entity]
#[ORM\Table(name: 'consultation_consents')]
#[ORM\UniqueConstraint(name: 'uniq_consent_appointment_type', columns: ['appointment_id', 'consent_type'])]
#[ORM\HasLifecycleCallbacks]
class ConsultationConsent
{
    use TimestampsTrait;

    public const TYPES   = ['recording', 'ai_transcription', 'data_sharing'];
    public const VERSION = '1.0';

    #[ORM\Id]
    #[ORM\Column(type: 'uuid')]
    private string $id;

    #[ORM\Column(name: 'appointment_id', type: 'uuid')]
    private string $appointmentId;

    #[ORM\Column(name: 'consent_type', type: 'string', length: 30)]
    private string $consentType;

    #[ORM\Column(type: 'boolean', options: ['default' => false])]
    private bool $granted = false;

    #[ORM\Column(name: 'decided_by_role', type: 'string', length: 20, nullable: true)]
    private ?string $decidedByRole = null;

    #[ORM\Column(name: 'decided_by_name', type: 'string', length: 200, nullable: true)]
    private ?string $decidedByName = null;

    #[ORM\Column(type: 'string', length: 10)]
    private string $version = self::VERSION;

    #[ORM\Column(name: 'decided_at', type: 'datetime_immutable', nullable: true)]
    private ?DateTimeImmutable $decidedAt = null;

    public function __construct(string $appointmentId, string $consentType)
    {
        $this->id            = Uuid::uuid4()->toString();
        $this->appointmentId = $appointmentId;
        $this->consentType   = $consentType;
    }

    public function isGranted(): bool
    {
        return $this->granted;
    }

    public function decide(bool $granted, string $role, string $name): void
    {
        $this->granted       = $granted;
        $this->decidedByRole = $role;
        $this->decidedByName = $name;
        $this->version       = self::VERSION;
        $this->decidedAt     = new DateTimeImmutable();
    }

    public function toArray(): array
    {
        return [
            'type'       => $this->consentType,
            'granted'    => $this->granted,
            'by_role'    => $this->decidedByRole,
            'by_name'    => $this->decidedByName,
            'version'    => $this->version,
            'decided_at' => $this->decidedAt?->format(DATE_ATOM),
        ];
    }
}
