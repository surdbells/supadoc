<?php

declare(strict_types=1);

namespace App\Domain\Entity;

use DateTimeImmutable;
use Doctrine\ORM\Mapping as ORM;
use Ramsey\Uuid\Uuid;

/**
 * A licensing document a doctor uploaded — the MDCN full-registration
 * certificate, an Annual Practising Licence (APL, with its number and expiry
 * date) or a specialist certificate. The file itself is sealed in the
 * {@see \App\Infrastructure\Storage\FileVault} (folder `credentials`), outside
 * the web root; only the doctor and back-office reviewers can open it, and
 * every reviewer view is audited.
 *
 * pending → verified (a reviewer checked it against the MDCN register and
 * attested to it) or rejected (with a reason the doctor sees). A newer upload
 * of the same kind supersedes an older pending one at once, and a verified one
 * when the newer one is verified; a verified APL past its expiry date is
 * marked expired by the licence cron.
 */
#[ORM\Entity]
#[ORM\Table(name: 'specialist_credentials')]
#[ORM\Index(name: 'idx_specialist_credentials_specialist', columns: ['specialist_id'])]
#[ORM\Index(name: 'idx_specialist_credentials_status', columns: ['status'])]
#[ORM\HasLifecycleCallbacks]
class SpecialistCredential
{
    use TimestampsTrait;

    public const TYPE_MDCN       = 'mdcn_full_registration';
    public const TYPE_LICENCE    = 'annual_practising_licence';
    public const TYPE_SPECIALIST = 'specialist_certificate';

    /** type => label */
    public const TYPES = [
        self::TYPE_MDCN       => 'MDCN full-registration certificate',
        self::TYPE_LICENCE    => 'Annual practising licence',
        self::TYPE_SPECIALIST => 'Specialist certificate',
    ];

    public const STATUS_PENDING    = 'pending';
    public const STATUS_VERIFIED   = 'verified';
    public const STATUS_REJECTED   = 'rejected';
    public const STATUS_EXPIRED    = 'expired';
    public const STATUS_SUPERSEDED = 'superseded';

    /** status => label */
    public const STATUSES = [
        self::STATUS_PENDING    => 'Awaiting verification',
        self::STATUS_VERIFIED   => 'Verified',
        self::STATUS_REJECTED   => 'Rejected',
        self::STATUS_EXPIRED    => 'Expired',
        self::STATUS_SUPERSEDED => 'Replaced',
    ];

    #[ORM\Id]
    #[ORM\Column(type: 'uuid')]
    private string $id;

    #[ORM\Column(name: 'specialist_id', type: 'uuid')]
    private string $specialistId;

    #[ORM\Column(type: 'string', length: 40)]
    private string $type;

    /** FileVault key of the sealed file — never leaves the server. */
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

    /** Licence / certificate number as printed on the document. */
    #[ORM\Column(type: 'string', length: 60, nullable: true)]
    private ?string $number = null;

    #[ORM\Column(name: 'issued_at', type: 'date_immutable', nullable: true)]
    private ?DateTimeImmutable $issuedAt = null;

    /** Last day the document is valid (required for an APL). */
    #[ORM\Column(name: 'expires_at', type: 'date_immutable', nullable: true)]
    private ?DateTimeImmutable $expiresAt = null;

    #[ORM\Column(type: 'string', length: 20)]
    private string $status = self::STATUS_PENDING;

    #[ORM\Column(name: 'rejection_reason', type: 'text', nullable: true)]
    private ?string $rejectionReason = null;

    /** The reviewer who verified or rejected it. */
    #[ORM\Column(name: 'reviewed_by', type: 'uuid', nullable: true)]
    private ?string $reviewedBy = null;

    #[ORM\Column(name: 'reviewed_by_name', type: 'string', length: 200, nullable: true)]
    private ?string $reviewedByName = null;

    #[ORM\Column(name: 'reviewed_at', type: 'datetime_immutable', nullable: true)]
    private ?DateTimeImmutable $reviewedAt = null;

    /**
     * The reviewer's attestation when verifying: {register_checked: true,
     * register_reference, note}. Back office only.
     *
     * @var array<string,mixed>|null
     */
    #[ORM\Column(type: 'json', nullable: true)]
    private ?array $attestation = null;

    /** The most urgent expiry reminder already sent (days before), so each stage goes once. */
    #[ORM\Column(name: 'reminder_stage', type: 'smallint', nullable: true)]
    private ?int $reminderStage = null;

    public function __construct(
        string $specialistId,
        string $type,
        string $vaultKey,
        string $originalName,
        string $mime,
        int $sizeBytes,
        string $sha256,
    ) {
        $this->id           = Uuid::uuid4()->toString();
        $this->specialistId = $specialistId;
        $this->type         = $type;
        $this->vaultKey     = $vaultKey;
        $this->originalName = mb_substr($originalName !== '' ? $originalName : 'document', 0, 200);
        $this->mime         = $mime;
        $this->sizeBytes    = $sizeBytes;
        $this->sha256       = $sha256;
    }

    public function getId(): string
    {
        return $this->id;
    }

    public function getSpecialistId(): string
    {
        return $this->specialistId;
    }

    public function getType(): string
    {
        return $this->type;
    }

    public function typeLabel(): string
    {
        return self::TYPES[$this->type] ?? 'Document';
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

    public function getStatus(): string
    {
        return $this->status;
    }

    public function isPending(): bool
    {
        return $this->status === self::STATUS_PENDING;
    }

    public function isVerified(): bool
    {
        return $this->status === self::STATUS_VERIFIED;
    }

    public function getNumber(): ?string
    {
        return $this->number;
    }

    public function setNumber(?string $number): void
    {
        $number       = $number !== null ? trim($number) : null;
        $this->number = $number !== null && $number !== '' ? mb_substr($number, 0, 60) : null;
    }

    public function getIssuedAt(): ?DateTimeImmutable
    {
        return $this->issuedAt;
    }

    public function setIssuedAt(?DateTimeImmutable $date): void
    {
        $this->issuedAt = $date;
    }

    public function getExpiresAt(): ?DateTimeImmutable
    {
        return $this->expiresAt;
    }

    public function setExpiresAt(?DateTimeImmutable $date): void
    {
        $this->expiresAt = $date;
    }

    /** The expiry as Y-m-d, or null. */
    public function expiresYmd(): ?string
    {
        return $this->expiresAt?->format('Y-m-d');
    }

    /** Past its last valid day on `$todayYmd` (the clinic's date). One with no expiry never is. */
    public function isExpiredOn(string $todayYmd): bool
    {
        $expires = $this->expiresYmd();

        return $expires !== null && $expires < $todayYmd;
    }

    public function getReviewedAt(): ?DateTimeImmutable
    {
        return $this->reviewedAt;
    }

    public function getReminderStage(): ?int
    {
        return $this->reminderStage;
    }

    public function setReminderStage(?int $stage): void
    {
        $this->reminderStage = $stage;
    }

    /**
     * A reviewer verified it against the MDCN register.
     *
     * @param array{register_checked:bool, register_reference:string, note:?string} $attestation
     */
    public function verify(?string $reviewerId, string $reviewerName, array $attestation, ?DateTimeImmutable $now = null): void
    {
        $this->status          = self::STATUS_VERIFIED;
        $this->rejectionReason = null;
        $this->reviewedBy      = $reviewerId !== null && Uuid::isValid($reviewerId) ? $reviewerId : null;
        $this->reviewedByName  = mb_substr($reviewerName, 0, 200);
        $this->reviewedAt      = $now ?? new DateTimeImmutable();
        $this->attestation     = $attestation;
        $this->reminderStage   = null;
    }

    /** A reviewer turned it down; the doctor sees why. */
    public function reject(string $reason, ?string $reviewerId, string $reviewerName, ?DateTimeImmutable $now = null): void
    {
        $this->status          = self::STATUS_REJECTED;
        $this->rejectionReason = trim($reason);
        $this->reviewedBy      = $reviewerId !== null && Uuid::isValid($reviewerId) ? $reviewerId : null;
        $this->reviewedByName  = mb_substr($reviewerName, 0, 200);
        $this->reviewedAt      = $now ?? new DateTimeImmutable();
    }

    /** A newer document of the same kind replaced it. */
    public function supersede(): void
    {
        $this->status = self::STATUS_SUPERSEDED;
    }

    /** The licence cron: its last valid day has passed. */
    public function markExpired(): void
    {
        $this->status = self::STATUS_EXPIRED;
    }

    /**
     * The doctor's view (and the base of the reviewer's): never the vault key or
     * the file hash. With `$forReviewer`, who reviewed it and their attestation.
     *
     * @return array<string,mixed>
     */
    public function toArray(bool $forReviewer = false): array
    {
        $out = [
            'id'               => $this->id,
            'type'             => $this->type,
            'type_label'       => $this->typeLabel(),
            'number'           => $this->number,
            'issued_at'        => $this->issuedAt?->format('Y-m-d'),
            'expires_at'       => $this->expiresYmd(),
            'status'           => $this->status,
            'status_label'     => self::STATUSES[$this->status] ?? ucfirst($this->status),
            'rejection_reason' => $this->rejectionReason,
            'original_name'    => $this->originalName,
            'mime'             => $this->mime,
            'size_bytes'       => $this->sizeBytes,
            'reviewed_at'      => $this->reviewedAt?->format(DATE_ATOM),
            'created_at'       => $this->createdAt->format(DATE_ATOM),
        ];
        if ($forReviewer) {
            $out += [
                'reviewed_by_name' => $this->reviewedByName,
                'attestation'      => $this->attestation,
                'sha256'           => $this->sha256,
            ];
        }

        return $out;
    }
}
