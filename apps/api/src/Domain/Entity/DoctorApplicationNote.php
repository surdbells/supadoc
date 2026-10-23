<?php

declare(strict_types=1);

namespace App\Domain\Entity;

use Doctrine\ORM\Mapping as ORM;
use Ramsey\Uuid\Uuid;

/** A reviewer's internal note on an application (spec §2.6) — staff only, never shown to the applicant. */
#[ORM\Entity]
#[ORM\Table(name: 'doctor_application_notes')]
#[ORM\Index(name: 'idx_doc_app_notes_app', columns: ['application_id'])]
#[ORM\HasLifecycleCallbacks]
class DoctorApplicationNote
{
    use TimestampsTrait;

    public const MAX_BODY = 4000;

    #[ORM\Id]
    #[ORM\Column(type: 'uuid')]
    private string $id;

    #[ORM\Column(name: 'application_id', type: 'uuid')]
    private string $applicationId;

    #[ORM\Column(name: 'author_id', type: 'uuid', nullable: true)]
    private ?string $authorId;

    #[ORM\Column(name: 'author_name', type: 'string', length: 200)]
    private string $authorName;

    #[ORM\Column(type: 'text')]
    private string $body;

    public function __construct(string $applicationId, ?string $authorId, string $authorName, string $body)
    {
        $this->id            = Uuid::uuid4()->toString();
        $this->applicationId = $applicationId;
        $this->authorId      = $authorId !== null && Uuid::isValid($authorId) ? $authorId : null;
        $this->authorName    = mb_substr(trim($authorName) !== '' ? trim($authorName) : 'Staff', 0, 200);
        $this->body          = $body;
    }

    public function getId(): string
    {
        return $this->id;
    }

    /** DoctorApplicationNoteDto. @return array<string,string> */
    public function toArray(): array
    {
        return [
            'id'          => $this->id,
            'author_name' => $this->authorName,
            'body'        => $this->body,
            'created_at'  => $this->getCreatedAt()->format(DATE_ATOM),
        ];
    }
}
