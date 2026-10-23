<?php

declare(strict_types=1);

namespace App\Domain\Entity;

use DateTimeImmutable;
use Doctrine\ORM\Mapping as ORM;
use Ramsey\Uuid\Uuid;

/**
 * A file an applicant uploaded (spec §2.3), sealed in the FileVault under
 * `applications/`. On a draft a slot holds one document and a re-upload or a
 * delete removes the old row and file. After submit (an info response) a new
 * upload marks the previous one `replaced` and keeps it, pointing back to it.
 * At approval a carried document becomes a verified credential (`credential_id`)
 * and its application copy is deleted (`file_purged_at`).
 */
#[ORM\Entity]
#[ORM\Table(name: 'doctor_application_documents')]
#[ORM\Index(name: 'idx_doc_app_docs_app_state', columns: ['application_id', 'state'])]
#[ORM\HasLifecycleCallbacks]
class DoctorApplicationDocument
{
    use TimestampsTrait;

    public const STATE_ACTIVE   = 'active';
    public const STATE_REPLACED = 'replaced';

    public const DURING_DRAFT = 'draft';
    public const DURING_INFO  = 'info_response';

    #[ORM\Id]
    #[ORM\Column(type: 'uuid')]
    private string $id;

    #[ORM\Column(name: 'application_id', type: 'uuid')]
    private string $applicationId;

    #[ORM\Column(type: 'string', length: 40)]
    private string $slot;

    /** `additional` only: what the reviewer asked for. */
    #[ORM\Column(type: 'string', length: 120, nullable: true)]
    private ?string $label = null;

    #[ORM\Column(name: 'vault_key', type: 'string', length: 120)]
    private string $vaultKey;

    #[ORM\Column(name: 'original_name', type: 'string', length: 200)]
    private string $originalName;

    #[ORM\Column(type: 'string', length: 100)]
    private string $mime;

    #[ORM\Column(name: 'size_bytes', type: 'integer')]
    private int $sizeBytes;

    #[ORM\Column(type: 'string', length: 64)]
    private string $sha256;

    #[ORM\Column(type: 'string', length: 12)]
    private string $state = self::STATE_ACTIVE;

    #[ORM\Column(name: 'uploaded_during', type: 'string', length: 16)]
    private string $uploadedDuring;

    #[ORM\Column(name: 'info_request_id', type: 'uuid', nullable: true)]
    private ?string $infoRequestId = null;

    /** Info response only: the active document this upload replaced. */
    #[ORM\Column(name: 'replaces_document_id', type: 'uuid', nullable: true)]
    private ?string $replacesDocumentId = null;

    #[ORM\Column(name: 'credential_id', type: 'uuid', nullable: true)]
    private ?string $credentialId = null;

    #[ORM\Column(name: 'file_purged_at', type: 'datetime_immutable', nullable: true)]
    private ?DateTimeImmutable $filePurgedAt = null;

    public function __construct(
        string $applicationId,
        string $slot,
        string $vaultKey,
        string $originalName,
        string $mime,
        int $sizeBytes,
        string $sha256,
        string $uploadedDuring = self::DURING_DRAFT,
        ?string $infoRequestId = null,
        ?string $label = null,
    ) {
        $this->id             = Uuid::uuid4()->toString();
        $this->applicationId  = $applicationId;
        $this->slot           = $slot;
        $this->vaultKey       = $vaultKey;
        $this->originalName   = mb_substr($originalName !== '' ? $originalName : 'document', 0, 200);
        $this->mime           = $mime;
        $this->sizeBytes      = $sizeBytes;
        $this->sha256         = $sha256;
        $this->uploadedDuring = $uploadedDuring;
        $this->infoRequestId  = $infoRequestId;
        $this->label          = $label !== null && trim($label) !== '' ? mb_substr(trim($label), 0, 120) : null;
    }

    public function getId(): string
    {
        return $this->id;
    }

    public function getApplicationId(): string
    {
        return $this->applicationId;
    }

    public function getSlot(): string
    {
        return $this->slot;
    }

    public function getLabel(): ?string
    {
        return $this->label;
    }

    public function getVaultKey(): string
    {
        return $this->vaultKey;
    }

    public function getOriginalName(): string
    {
        return $this->originalName;
    }

    public function getMime(): string
    {
        return $this->mime;
    }

    public function getSizeBytes(): int
    {
        return $this->sizeBytes;
    }

    public function getSha256(): string
    {
        return $this->sha256;
    }

    public function getState(): string
    {
        return $this->state;
    }

    public function isActive(): bool
    {
        return $this->state === self::STATE_ACTIVE;
    }

    public function markReplaced(): void
    {
        $this->state = self::STATE_REPLACED;
    }

    public function reactivate(): void
    {
        $this->state = self::STATE_ACTIVE;
    }

    public function getUploadedDuring(): string
    {
        return $this->uploadedDuring;
    }

    public function getInfoRequestId(): ?string
    {
        return $this->infoRequestId;
    }

    public function getReplacesDocumentId(): ?string
    {
        return $this->replacesDocumentId;
    }

    public function setReplacesDocumentId(?string $id): void
    {
        $this->replacesDocumentId = $id;
    }

    public function getCredentialId(): ?string
    {
        return $this->credentialId;
    }

    public function setCredentialId(?string $id): void
    {
        $this->credentialId = $id;
    }

    public function getFilePurgedAt(): ?DateTimeImmutable
    {
        return $this->filePurgedAt;
    }

    public function markFilePurged(DateTimeImmutable $at): void
    {
        $this->filePurgedAt = $at;
    }
}
