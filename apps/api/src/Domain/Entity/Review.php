<?php

declare(strict_types=1);

namespace App\Domain\Entity;

use DateTimeImmutable;
use Doctrine\ORM\Mapping as ORM;
use Ramsey\Uuid\Uuid;

/**
 * A patient's rating + review of a specialist, left after a completed
 * consultation. The doctor may post one public response. The specialist's cached
 * rating / reviews_count are recomputed from these.
 */
#[ORM\Entity]
#[ORM\Table(name: 'reviews')]
#[ORM\Index(name: 'idx_reviews_specialist', columns: ['specialist_id', 'created_at'])]
#[ORM\Index(name: 'idx_reviews_appointment', columns: ['appointment_id'])]
#[ORM\HasLifecycleCallbacks]
class Review
{
    use TimestampsTrait;

    #[ORM\Id]
    #[ORM\Column(type: 'uuid')]
    private string $id;

    #[ORM\Column(name: 'specialist_id', type: 'uuid')]
    private string $specialistId;

    #[ORM\Column(name: 'patient_id', type: 'uuid')]
    private string $patientId;

    #[ORM\Column(name: 'patient_name', type: 'string', length: 200)]
    private string $patientName;

    #[ORM\Column(name: 'appointment_id', type: 'uuid', nullable: true)]
    private ?string $appointmentId = null;

    #[ORM\Column(type: 'integer')]
    private int $rating;

    #[ORM\Column(type: 'text', nullable: true)]
    private ?string $comment = null;

    #[ORM\Column(type: 'text', nullable: true)]
    private ?string $response = null;

    #[ORM\Column(name: 'responded_at', type: 'datetime_immutable', nullable: true)]
    private ?DateTimeImmutable $respondedAt = null;

    public function __construct(
        string $specialistId,
        string $patientId,
        string $patientName,
        int $rating,
        ?string $comment = null,
        ?string $appointmentId = null,
    ) {
        $this->id            = Uuid::uuid4()->toString();
        $this->specialistId  = $specialistId;
        $this->patientId     = $patientId;
        $this->patientName   = $patientName;
        $this->rating        = max(1, min(5, $rating));
        $this->comment       = $comment !== null && trim($comment) !== '' ? trim($comment) : null;
        $this->appointmentId = $appointmentId;
    }

    public function getId(): string
    {
        return $this->id;
    }
    public function getSpecialistId(): string
    {
        return $this->specialistId;
    }

    public function respond(string $response): void
    {
        $this->response    = trim($response) !== '' ? trim($response) : null;
        $this->respondedAt = new DateTimeImmutable();
    }

    /** @return array<string,mixed> */
    public function toArray(): array
    {
        return [
            'id'             => $this->id,
            'specialist_id'  => $this->specialistId,
            'patient_name'   => $this->patientName,
            'appointment_id' => $this->appointmentId,
            'rating'         => $this->rating,
            'comment'        => $this->comment,
            'response'       => $this->response,
            'responded_at'   => $this->respondedAt?->format(DATE_ATOM),
            'created_at'     => $this->createdAt->format(DATE_ATOM),
        ];
    }
}
