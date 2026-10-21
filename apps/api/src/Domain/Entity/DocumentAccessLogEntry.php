<?php

declare(strict_types=1);

namespace App\Domain\Entity;

use DateTimeImmutable;
use Doctrine\ORM\Mapping as ORM;

/**
 * The disclosure ledger (spec §1.3): the authoritative patient-facing record
 * of who could see and who opened what — every share, change, end, request and
 * EVERY doctor file view (no write-side coalescing; the patient UI folds
 * repeats for display). Append-only: no setters, no updated_at, plain uuids
 * with no foreign keys (a removed document or appointment must not erase the
 * record). Written in the same transaction as the change it records.
 *
 * `details` is non-PHI only (scope, duration, expires_at, previous_expires_at,
 * previous_scope, document_count, end_reason, capped, surface,
 * consent_version, via) — never a title or a type.
 */
#[ORM\Entity]
#[ORM\Table(name: 'document_access_log')]
#[ORM\Index(name: 'idx_doc_log_patient', columns: ['patient_id', 'created_at'])]
#[ORM\Index(name: 'idx_doc_log_document', columns: ['document_id', 'specialist_id', 'created_at'])]
class DocumentAccessLogEntry
{
    public const EVENTS = [
        'viewed', 'shared', 'changed', 'extended', 'revoked', 'restored',
        'document_removed', 'document_shown', 'expired',
        'requested', 'request_approved', 'request_declined', 'request_cancelled', 'request_expired',
        'requests_blocked', 'requests_allowed',
    ];

    #[ORM\Id]
    #[ORM\Column(type: 'uuid')]
    private string $id;

    #[ORM\Column(name: 'patient_id', type: 'uuid')]
    private string $patientId;

    #[ORM\Column(name: 'specialist_id', type: 'uuid', nullable: true)]
    private ?string $specialistId = null;

    #[ORM\Column(name: 'document_id', type: 'uuid', nullable: true)]
    private ?string $documentId = null;

    #[ORM\Column(name: 'grant_id', type: 'uuid', nullable: true)]
    private ?string $grantId = null;

    #[ORM\Column(name: 'request_id', type: 'uuid', nullable: true)]
    private ?string $requestId = null;

    #[ORM\Column(name: 'appointment_id', type: 'uuid', nullable: true)]
    private ?string $appointmentId = null;

    #[ORM\Column(name: 'event', type: 'string', length: 24)]
    private string $event;

    /** patient | doctor | system */
    #[ORM\Column(name: 'actor_role', type: 'string', length: 10)]
    private string $actorRole;

    /** @var array<string,mixed>|null */
    #[ORM\Column(name: 'details', type: 'json', nullable: true)]
    private ?array $details = null;

    #[ORM\Column(name: 'created_at', type: 'datetime_immutable')]
    private DateTimeImmutable $createdAt;

    private function __construct()
    {
    }

    public function getEvent(): string
    {
        return $this->event;
    }
}
