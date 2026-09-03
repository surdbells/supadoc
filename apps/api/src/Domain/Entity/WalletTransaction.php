<?php

declare(strict_types=1);

namespace App\Domain\Entity;

use DateTimeImmutable;
use Doctrine\ORM\Mapping as ORM;
use Ramsey\Uuid\Uuid;

/**
 * One entry in a wallet's append-only ledger. Each entry is a single posting
 * against the wallet with a signed effect (credit/debit), the resulting
 * `balanceAfter`, and a unique `reference` for idempotency. Entries are immutable
 * once `success`; a pending top-up transitions pending → success|failed exactly
 * once. This ledger IS the book of record — the wallet's cached balance is derived
 * from it. See {@see \App\Infrastructure\Service\WalletService}.
 */
#[ORM\Entity]
#[ORM\Table(name: 'wallet_transactions')]
#[ORM\UniqueConstraint(name: 'uniq_wallet_txn_reference', columns: ['reference'])]
#[ORM\Index(name: 'idx_wallet_txn_wallet', columns: ['wallet_id', 'created_at'])]
#[ORM\Index(name: 'idx_wallet_txn_patient', columns: ['patient_id'])]
#[ORM\HasLifecycleCallbacks]
class WalletTransaction
{
    use TimestampsTrait;

    // Ledger entry type.
    public const TYPE_TOPUP        = 'topup';
    public const TYPE_CONSULTATION = 'consultation';
    public const TYPE_REFUND       = 'refund';
    public const TYPE_REVERSAL     = 'reversal';
    public const TYPE_ADJUSTMENT   = 'adjustment';

    public const DIR_CREDIT = 'credit';
    public const DIR_DEBIT  = 'debit';

    public const STATUS_PENDING  = 'pending';
    public const STATUS_SUCCESS  = 'success';
    public const STATUS_FAILED   = 'failed';
    public const STATUS_REVERSED = 'reversed';

    #[ORM\Id]
    #[ORM\Column(type: 'uuid')]
    private string $id;

    #[ORM\Column(name: 'wallet_id', type: 'uuid')]
    private string $walletId;

    #[ORM\Column(name: 'patient_id', type: 'uuid')]
    private string $patientId;

    #[ORM\Column(type: 'string', length: 20)]
    private string $type;

    #[ORM\Column(type: 'string', length: 10)]
    private string $direction;

    #[ORM\Column(type: 'decimal', precision: 18, scale: 2)]
    private string $amount;

    #[ORM\Column(type: 'string', length: 3)]
    private string $currency;

    /** Wallet balance immediately after this entry posted (null while pending). */
    #[ORM\Column(name: 'balance_after', type: 'decimal', precision: 18, scale: 2, nullable: true)]
    private ?string $balanceAfter = null;

    #[ORM\Column(type: 'string', length: 20)]
    private string $status;

    /** Idempotency key — our own unique reference (also sent to the gateway). */
    #[ORM\Column(type: 'string', length: 80)]
    private string $reference;

    #[ORM\Column(name: 'provider', type: 'string', length: 20, nullable: true)]
    private ?string $provider = null;

    #[ORM\Column(name: 'provider_reference', type: 'string', length: 120, nullable: true)]
    private ?string $providerReference = null;

    #[ORM\Column(type: 'string', length: 255, nullable: true)]
    private ?string $description = null;

    /** @var array<string,mixed>|null */
    #[ORM\Column(type: 'json', nullable: true)]
    private ?array $metadata = null;

    #[ORM\Column(name: 'posted_at', type: 'datetime_immutable', nullable: true)]
    private ?DateTimeImmutable $postedAt = null;

    public function __construct(
        string $walletId,
        string $patientId,
        string $type,
        string $direction,
        string $amount,
        string $currency,
        string $reference,
        string $status = self::STATUS_PENDING,
    ) {
        $this->id        = Uuid::uuid4()->toString();
        $this->walletId  = $walletId;
        $this->patientId = $patientId;
        $this->type      = $type;
        $this->direction = $direction;
        $this->amount    = $amount;
        $this->currency  = strtoupper($currency);
        $this->reference = $reference;
        $this->status    = $status;
    }

    public function getId(): string
    {
        return $this->id;
    }

    public function getReference(): string
    {
        return $this->reference;
    }

    public function getWalletId(): string
    {
        return $this->walletId;
    }

    public function getPatientId(): string
    {
        return $this->patientId;
    }

    public function getType(): string
    {
        return $this->type;
    }

    public function getDirection(): string
    {
        return $this->direction;
    }

    public function getAmount(): string
    {
        return $this->amount;
    }

    public function getCurrency(): string
    {
        return $this->currency;
    }

    public function getStatus(): string
    {
        return $this->status;
    }

    public function isSuccess(): bool
    {
        return $this->status === self::STATUS_SUCCESS;
    }

    public function isPending(): bool
    {
        return $this->status === self::STATUS_PENDING;
    }

    /** Mark the entry posted with the resulting running balance (settlement). */
    public function markPosted(string $balanceAfter, ?string $provider = null, ?string $providerReference = null): void
    {
        $this->status       = self::STATUS_SUCCESS;
        $this->balanceAfter = $balanceAfter;
        $this->postedAt     = new DateTimeImmutable();
        if ($provider !== null) {
            $this->provider = $provider;
        }
        if ($providerReference !== null) {
            $this->providerReference = $providerReference;
        }
    }

    public function markFailed(): void
    {
        $this->status = self::STATUS_FAILED;
    }

    public function setProvider(string $provider, ?string $providerReference = null): void
    {
        $this->provider          = $provider;
        $this->providerReference = $providerReference;
    }

    public function setDescription(?string $description): void
    {
        $this->description = $description;
    }

    /** @param array<string,mixed> $metadata */
    public function setMetadata(array $metadata): void
    {
        $this->metadata = $metadata !== [] ? $metadata : null;
    }

    /** Signed label used by the UI: "Top-up", "Paid out", "Refund". */
    public function label(): string
    {
        return match ($this->type) {
            self::TYPE_TOPUP        => 'Top-up',
            self::TYPE_CONSULTATION => 'Paid out',
            self::TYPE_REFUND       => 'Refund',
            self::TYPE_REVERSAL     => 'Reversal',
            default                 => 'Adjustment',
        };
    }

    public function toArray(): array
    {
        return [
            'id'            => $this->id,
            'type'          => $this->type,
            'label'         => $this->label(),
            'direction'     => $this->direction,
            'amount'        => $this->amount,
            'currency'      => $this->currency,
            'balance_after' => $this->balanceAfter,
            'status'        => $this->status,
            'reference'     => $this->reference,
            'description'   => $this->description,
            'created_at'    => $this->getCreatedAt()->format(DATE_ATOM),
        ];
    }
}
