<?php

declare(strict_types=1);

namespace App\Domain\Entity;

use DateTimeImmutable;
use Doctrine\ORM\Mapping as ORM;

/**
 * The patient stopped a doctor asking for document access (declined with
 * "Don't let Dr X ask again"). Open while `lifted_at` is NULL; the patient
 * lifts it with "Allow requests". One open block per pair is a partial unique
 * index (RawIndexes). Plain columns.
 */
#[ORM\Entity]
#[ORM\Table(name: 'document_access_blocks')]
#[ORM\Index(name: 'idx_doc_blocks_pair', columns: ['patient_id', 'specialist_id'])]
class DocumentAccessBlock
{
    #[ORM\Id]
    #[ORM\Column(type: 'uuid')]
    private string $id;

    #[ORM\Column(name: 'patient_id', type: 'uuid')]
    private string $patientId;

    #[ORM\Column(name: 'specialist_id', type: 'uuid')]
    private string $specialistId;

    /** The declined request that set it. */
    #[ORM\Column(name: 'request_id', type: 'uuid', nullable: true)]
    private ?string $requestId = null;

    #[ORM\Column(name: 'created_at', type: 'datetime_immutable')]
    private DateTimeImmutable $createdAt;

    #[ORM\Column(name: 'lifted_at', type: 'datetime_immutable', nullable: true)]
    private ?DateTimeImmutable $liftedAt = null;

    private function __construct()
    {
    }

    public function isOpen(): bool
    {
        return $this->liftedAt === null;
    }
}
