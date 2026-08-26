<?php

declare(strict_types=1);

namespace App\Domain\Entity;

use DateTimeImmutable;
use Doctrine\ORM\Mapping as ORM;
use Ramsey\Uuid\Uuid;

/**
 * A cloud-recording session for a consultation. Created only after the patient's
 * recording consent is verified (see StartRecordingAction) — the app never records
 * silently. Tracks Agora's resourceId/sid so the session can be stopped, and the
 * resulting file list once finished.
 */
#[ORM\Entity]
#[ORM\Table(name: 'recordings')]
#[ORM\Index(name: 'idx_recordings_appointment', columns: ['appointment_id'])]
#[ORM\HasLifecycleCallbacks]
class Recording
{
    use TimestampsTrait;

    public const STATUS_RECORDING = 'recording';
    public const STATUS_STOPPED   = 'stopped';
    public const STATUS_FAILED    = 'failed';

    #[ORM\Id]
    #[ORM\Column(type: 'uuid')]
    private string $id;

    #[ORM\Column(name: 'appointment_id', type: 'uuid')]
    private string $appointmentId;

    #[ORM\Column(type: 'string', length: 128)]
    private string $channel;

    #[ORM\Column(name: 'resource_id', type: 'text')]
    private string $resourceId;

    #[ORM\Column(type: 'string', length: 128)]
    private string $sid;

    #[ORM\Column(type: 'string', length: 20, options: ['default' => self::STATUS_RECORDING])]
    private string $status = self::STATUS_RECORDING;

    #[ORM\Column(name: 'started_by_name', type: 'string', length: 200, nullable: true)]
    private ?string $startedByName = null;

    #[ORM\Column(name: 'started_at', type: 'datetime_immutable')]
    private DateTimeImmutable $startedAt;

    #[ORM\Column(name: 'stopped_at', type: 'datetime_immutable', nullable: true)]
    private ?DateTimeImmutable $stoppedAt = null;

    /** @var list<string>|null */
    #[ORM\Column(type: 'json', nullable: true)]
    private ?array $files = null;

    public function __construct(
        string $appointmentId,
        string $channel,
        string $resourceId,
        string $sid,
        string $startedByName,
    ) {
        $this->id            = Uuid::uuid4()->toString();
        $this->appointmentId = $appointmentId;
        $this->channel       = $channel;
        $this->resourceId    = $resourceId;
        $this->sid           = $sid;
        $this->startedByName = $startedByName;
        $this->startedAt     = new DateTimeImmutable();
    }

    public function getId(): string
    {
        return $this->id;
    }

    public function getResourceId(): string
    {
        return $this->resourceId;
    }

    public function getSid(): string
    {
        return $this->sid;
    }

    public function getChannel(): string
    {
        return $this->channel;
    }

    public function isActive(): bool
    {
        return $this->status === self::STATUS_RECORDING;
    }

    /** @param list<string> $files */
    public function markStopped(array $files): void
    {
        $this->status    = self::STATUS_STOPPED;
        $this->stoppedAt = new DateTimeImmutable();
        $this->files     = $files !== [] ? $files : null;
    }

    public function markFailed(): void
    {
        $this->status    = self::STATUS_FAILED;
        $this->stoppedAt = new DateTimeImmutable();
    }

    public function toArray(): array
    {
        return [
            'id'             => $this->id,
            'appointment_id' => $this->appointmentId,
            'status'         => $this->status,
            'started_by'     => $this->startedByName,
            'started_at'     => $this->startedAt->format(DATE_ATOM),
            'stopped_at'     => $this->stoppedAt?->format(DATE_ATOM),
            'files'          => $this->files ?? [],
        ];
    }
}
