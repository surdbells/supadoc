<?php

declare(strict_types=1);

namespace App\Domain\Entity;

use DateTimeImmutable;
use Doctrine\ORM\Mapping as ORM;
use Ramsey\Uuid\Uuid;

/**
 * A single RTC connection-quality sample reported by a call client (patient or
 * doctor) during a consultation. Append-only. Uplink/downlink use Agora's network
 * quality scale (0 unknown, 1 excellent … 6 down); rtt is round-trip time in ms.
 */
#[ORM\Entity]
#[ORM\Table(name: 'session_metrics')]
#[ORM\Index(name: 'idx_metrics_appointment', columns: ['appointment_id'])]
#[ORM\Index(name: 'idx_metrics_created', columns: ['created_at'])]
class SessionMetric
{
    #[ORM\Id]
    #[ORM\Column(type: 'uuid')]
    private string $id;

    #[ORM\Column(name: 'appointment_id', type: 'uuid')]
    private string $appointmentId;

    #[ORM\Column(type: 'string', length: 20)]
    private string $role;

    #[ORM\Column(type: 'smallint')]
    private int $uplink;

    #[ORM\Column(type: 'smallint')]
    private int $downlink;

    #[ORM\Column(type: 'integer', nullable: true)]
    private ?int $rtt;

    #[ORM\Column(name: 'created_at', type: 'datetime_immutable')]
    private DateTimeImmutable $createdAt;

    public function __construct(string $appointmentId, string $role, int $uplink, int $downlink, ?int $rtt)
    {
        $this->id            = Uuid::uuid4()->toString();
        $this->appointmentId = $appointmentId;
        $this->role          = $role;
        $this->uplink        = self::clampQuality($uplink);
        $this->downlink      = self::clampQuality($downlink);
        $this->rtt           = $rtt !== null && $rtt >= 0 && $rtt < 100000 ? $rtt : null;
        $this->createdAt     = new DateTimeImmutable();
    }

    private static function clampQuality(int $q): int
    {
        return max(0, min(6, $q));
    }

    public function getAppointmentId(): string
    {
        return $this->appointmentId;
    }

    public function getRole(): string
    {
        return $this->role;
    }

    public function getUplink(): int
    {
        return $this->uplink;
    }

    public function getDownlink(): int
    {
        return $this->downlink;
    }

    public function getRtt(): ?int
    {
        return $this->rtt;
    }

    /** Worst (highest) of uplink/downlink — the effective quality for this sample. */
    public function worst(): int
    {
        return max($this->uplink, $this->downlink);
    }

    public function toArray(): array
    {
        return [
            'appointment_id' => $this->appointmentId,
            'role'           => $this->role,
            'uplink'         => $this->uplink,
            'downlink'       => $this->downlink,
            'rtt'            => $this->rtt,
            'created_at'     => $this->createdAt->format(DATE_ATOM),
        ];
    }
}
