<?php

declare(strict_types=1);

namespace App\Domain\Entity;

use DateTimeImmutable;
use Doctrine\ORM\Mapping as ORM;

/**
 * One share submission the patient made (POST /portal/document-access/grants,
 * spec §3.5): its `client_key`, the hash of its normalised body and what it
 * did. A create that merged into an existing share (`extended`, `unchanged`,
 * `merged`) stores its key nowhere on the grants, so this row is what lets a
 * retry of the same submission be answered as a replay (200, `replayed`)
 * within 24 hours, and a different body with the same key be refused (409
 * `idempotency_conflict`). Written in the share's own transaction;
 * append-only; plain uuids, no foreign keys. Never holds a title or a type.
 */
#[ORM\Entity]
#[ORM\Table(name: 'document_access_submissions')]
#[ORM\UniqueConstraint(name: 'uniq_doc_submissions_key', columns: ['patient_id', 'client_key'])]
class DocumentAccessSubmission
{
    #[ORM\Id]
    #[ORM\Column(type: 'uuid')]
    private string $id;

    #[ORM\Column(name: 'patient_id', type: 'uuid')]
    private string $patientId;

    #[ORM\Column(name: 'client_key', type: 'string', length: 36)]
    private string $clientKey;

    /** sha256 of the canonical, normalised request (DocumentSharingRules::requestHash). */
    #[ORM\Column(name: 'request_hash', type: 'string', length: 64, options: ['fixed' => true])]
    private string $requestHash;

    /** @var list<string> the grants the submission created or changed, in answer order */
    #[ORM\Column(name: 'grant_ids', type: 'json')]
    private array $grantIds = [];

    /** @var list<array{specialist_id:string, grant_id:string, outcome:string}> per doctor, as first answered */
    #[ORM\Column(name: 'outcomes', type: 'json')]
    private array $outcomes = [];

    /** @var list<string> the request it answered (`answers_request_id`), if any */
    #[ORM\Column(name: 'approved_request_ids', type: 'json')]
    private array $approvedRequestIds = [];

    #[ORM\Column(name: 'created_at', type: 'datetime_immutable')]
    private DateTimeImmutable $createdAt;

    private function __construct()
    {
    }

    public function getClientKey(): string
    {
        return $this->clientKey;
    }
}
