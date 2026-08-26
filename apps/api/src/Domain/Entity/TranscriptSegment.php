<?php

declare(strict_types=1);

namespace App\Domain\Entity;

use DateTimeImmutable;
use Doctrine\ORM\Mapping as ORM;
use Ramsey\Uuid\Uuid;

/**
 * One finalized utterance in a consultation's live transcript, attributed to the
 * speaker (patient or doctor). Produced client-side by the browser's speech
 * recognition and only ever captured with the patient's AI-transcription consent.
 * Append-only.
 */
#[ORM\Entity]
#[ORM\Table(name: 'transcript_segments')]
#[ORM\Index(name: 'idx_transcript_appointment', columns: ['appointment_id'])]
#[ORM\Index(name: 'idx_transcript_created', columns: ['created_at'])]
class TranscriptSegment
{
    #[ORM\Id]
    #[ORM\Column(type: 'uuid')]
    private string $id;

    #[ORM\Column(name: 'appointment_id', type: 'uuid')]
    private string $appointmentId;

    #[ORM\Column(type: 'string', length: 20)]
    private string $role;

    #[ORM\Column(type: 'text')]
    private string $text;

    #[ORM\Column(name: 'created_at', type: 'datetime_immutable')]
    private DateTimeImmutable $createdAt;

    public function __construct(string $appointmentId, string $role, string $text)
    {
        $this->id            = Uuid::uuid4()->toString();
        $this->appointmentId = $appointmentId;
        $this->role          = $role;
        $this->text          = $text;
        $this->createdAt     = new DateTimeImmutable();
    }

    public function getRole(): string
    {
        return $this->role;
    }

    public function getText(): string
    {
        return $this->text;
    }

    public function toArray(): array
    {
        return [
            'id'   => $this->id,
            'role' => $this->role,
            'text' => $this->text,
            'at'   => $this->createdAt->format(DATE_ATOM),
        ];
    }
}
