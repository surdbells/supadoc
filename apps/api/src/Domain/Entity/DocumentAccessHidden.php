<?php

declare(strict_types=1);

namespace App\Domain\Entity;

use DateTimeImmutable;
use Doctrine\ORM\Mapping as ORM;

/**
 * "Doctor X must not see this document through a whole-folder share" (spec
 * §1.1). It belongs to the PAIR (patient, specialist), not to a grant, so it
 * survives revoke, expiry, a brand-new folder share, scope round trips and
 * edits. Open while `cleared_at` is NULL; cleared only by an explicit "show
 * through the folder" choice (Show again, Show them too, a booking tick).
 * Plain columns, no foreign keys. One open row per (pair, document) is a
 * partial unique index (RawIndexes).
 */
#[ORM\Entity]
#[ORM\Table(name: 'document_access_hidden')]
#[ORM\Index(name: 'idx_doc_hidden_pair', columns: ['patient_id', 'specialist_id'])]
class DocumentAccessHidden
{
    #[ORM\Id]
    #[ORM\Column(type: 'uuid')]
    private string $id;

    #[ORM\Column(name: 'patient_id', type: 'uuid')]
    private string $patientId;

    #[ORM\Column(name: 'specialist_id', type: 'uuid')]
    private string $specialistId;

    #[ORM\Column(name: 'document_id', type: 'uuid')]
    private string $documentId;

    #[ORM\Column(name: 'created_at', type: 'datetime_immutable')]
    private DateTimeImmutable $createdAt;

    /** Where it was hidden: a grant surface, or remove_access / booking_default. */
    #[ORM\Column(name: 'created_surface', type: 'string', length: 24)]
    private string $createdSurface;

    #[ORM\Column(name: 'cleared_at', type: 'datetime_immutable', nullable: true)]
    private ?DateTimeImmutable $clearedAt = null;

    #[ORM\Column(name: 'cleared_surface', type: 'string', length: 24, nullable: true)]
    private ?string $clearedSurface = null;

    private function __construct()
    {
    }

    public function isOpen(): bool
    {
        return $this->clearedAt === null;
    }
}
