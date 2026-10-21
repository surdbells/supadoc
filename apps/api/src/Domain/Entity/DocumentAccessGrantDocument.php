<?php

declare(strict_types=1);

namespace App\Domain\Entity;

use DateTimeImmutable;
use Doctrine\ORM\Mapping as ORM;

/**
 * One document on a `selected` grant (spec §1.3). `document_id` is a plain
 * column with no foreign key: a future document delete must not erase the
 * record of what was shared — the policy's JOIN to medical_documents simply
 * hides a missing one.
 */
#[ORM\Entity]
#[ORM\Table(name: 'document_access_grant_documents')]
#[ORM\UniqueConstraint(name: 'uniq_doc_grant_document', columns: ['grant_id', 'document_id'])]
#[ORM\Index(name: 'idx_doc_grant_docs_document', columns: ['document_id'])]
class DocumentAccessGrantDocument
{
    #[ORM\Id]
    #[ORM\Column(type: 'uuid')]
    private string $id;

    #[ORM\ManyToOne(targetEntity: DocumentAccessGrant::class, inversedBy: 'documents')]
    #[ORM\JoinColumn(name: 'grant_id', referencedColumnName: 'id', nullable: false, onDelete: 'CASCADE')]
    private DocumentAccessGrant $grant;

    #[ORM\Column(name: 'document_id', type: 'uuid')]
    private string $documentId;

    #[ORM\Column(name: 'created_at', type: 'datetime_immutable')]
    private DateTimeImmutable $createdAt;

    private function __construct()
    {
    }

    public function getDocumentId(): string
    {
        return $this->documentId;
    }
}
