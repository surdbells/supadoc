<?php

declare(strict_types=1);

namespace App\Domain\Entity;

use DateTimeImmutable;
use Doctrine\ORM\Mapping as ORM;
use Ramsey\Uuid\Uuid;

/**
 * One entry in a wallet's append-only ledger. Each entry is a single posting
 * against the wallet with a signed effect (credit/debit), the resulting
 * `balanceAfter`, and a unique `reference` for idempotency. This ledger IS the
 * book of record — the wallet's cached balance is derived from it. See
 * {@see \App\Infrastructure\Service\WalletService}.
 *
 * Status transitions (enforced here; WalletService additionally makes each one
 * a locked compare-and-set in the database, so concurrent requests can't both
 * win):
 *
 *   pending ─┬─> success   (posted: the balance moved — exactly once, ever)
 *            ├─> failed    (the gateway says the charge failed; may still be
 *            │              settled later if the gateway then reports success)
 *            └─> review    (paid, but not the amount/currency asked for:
 *                           nothing credited, held for support)
 *   failed  ─┬─> success | review
 *   review  ───> resolved  (support decided; terminal, never credited by settle)
 *
 * `success` and `resolved` are final.
 *
 * An entry that already carries `posted_at` / `balance_after` has moved money,
 * whatever its status says. The pre-fix code could leave such rows marked
 * `failed` (a late "charge failed" flushed over a credit that had just landed:
 * only `status` was rewritten). Those are never settleable, failed or held —
 * they would be credited a second time — and only support's
 * {@see restorePosted()} (status back to success, no balance change) moves them.
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
    /** Paid, but the verified amount/currency differed from what was asked: not credited, held for support. */
    public const STATUS_REVIEW   = 'review';
    /** A held entry support has dealt with (credited separately, or refunded on the gateway). Terminal. */
    public const STATUS_RESOLVED = 'resolved';

    /** Statuses a top-up can still be credited (or held) from — provided it never posted ({@see isSettleable()}). */
    public const SETTLEABLE = [self::STATUS_PENDING, self::STATUS_FAILED];

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

    /**
     * Whether this entry can still be posted (or held for review): pending or
     * failed, and it never moved money ({@see wasPosted()}).
     */
    public function isSettleable(): bool
    {
        return in_array($this->status, self::SETTLEABLE, true) && !$this->wasPosted();
    }

    /**
     * Whether this entry has moved the balance: it carries a posting time or a
     * resulting balance. True for every `success` entry — and for a pre-fix
     * row the late-failure race left `failed` after it was credited.
     */
    public function wasPosted(): bool
    {
        return $this->postedAt !== null || $this->balanceAfter !== null;
    }

    /**
     * A pending/failed entry that nevertheless moved money (the old race; see
     * the class doc): the money is in the wallet but the ledger doesn't count it.
     * Never settle it — support restores it with {@see restorePosted()}.
     */
    public function isPostedButNotSuccess(): bool
    {
        return $this->status !== self::STATUS_SUCCESS && $this->wasPosted();
    }

    /** Paid with the wrong amount/currency and waiting for support. */
    public function needsReview(): bool
    {
        return $this->status === self::STATUS_REVIEW;
    }

    public function isTopup(): bool
    {
        return $this->type === self::TYPE_TOPUP && $this->direction === self::DIR_CREDIT;
    }

    public function getBalanceAfter(): ?string
    {
        return $this->balanceAfter;
    }

    public function getPostedAt(): ?DateTimeImmutable
    {
        return $this->postedAt;
    }

    public function getProvider(): ?string
    {
        return $this->provider;
    }

    public function getProviderReference(): ?string
    {
        return $this->providerReference;
    }

    /** @return array<string,mixed> */
    public function getMetadata(): array
    {
        return $this->metadata ?? [];
    }

    /**
     * Mark the entry posted with the resulting running balance (settlement).
     * Only a pending or failed entry that never posted can be posted — posting
     * an entry twice would mean its money moved twice, so that throws.
     *
     * @throws \LogicException when the entry is not pending/failed, or already posted
     */
    public function markPosted(string $balanceAfter, ?string $provider = null, ?string $providerReference = null): void
    {
        $this->guard(self::SETTLEABLE, self::STATUS_SUCCESS);
        $this->guardNotPosted(self::STATUS_SUCCESS);
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

    /**
     * The gateway reported the charge failed. Only a pending entry fails — a
     * posted (or held) one is never downgraded.
     *
     * @throws \LogicException when the entry is not pending, or already posted
     */
    public function markFailed(): void
    {
        $this->guard([self::STATUS_PENDING], self::STATUS_FAILED);
        $this->guardNotPosted(self::STATUS_FAILED);
        $this->status = self::STATUS_FAILED;
    }

    /**
     * Paid, but not what was asked for: hold it (nothing credited) for support,
     * recording what the gateway verified.
     *
     * @param array<string,mixed> $details
     * @throws \LogicException when the entry is not pending/failed, or already posted
     */
    public function holdForReview(array $details, ?string $providerReference = null): void
    {
        $this->guard(self::SETTLEABLE, self::STATUS_REVIEW);
        $this->guardNotPosted(self::STATUS_REVIEW);
        $this->status = self::STATUS_REVIEW;
        if ($providerReference !== null) {
            $this->providerReference = $providerReference;
        }
        $this->mergeMetadata(['review' => $details]);
    }

    /**
     * Support dealt with a held entry (see WalletService::resolveHeldTopup()).
     *
     * @param array<string,mixed> $details
     * @throws \LogicException when the entry is not held for review
     */
    public function markResolved(array $details): void
    {
        $this->guard([self::STATUS_REVIEW], self::STATUS_RESOLVED);
        $this->status = self::STATUS_RESOLVED;
        $this->mergeMetadata(['resolution' => $details]);
    }

    /**
     * Support's correction for a row the old race left pending/failed AFTER it
     * was credited (see WalletService::restorePostedTopup()): the status goes
     * back to `success` so the ledger counts money the wallet already holds.
     * Nothing else changes — its posting time and resulting balance stay what
     * they were — and no money moves.
     *
     * @param array<string,mixed> $details
     * @throws \LogicException unless the entry is pending/failed with both posting time and resulting balance recorded
     */
    public function restorePosted(array $details): void
    {
        $this->guard(self::SETTLEABLE, self::STATUS_SUCCESS);
        if ($this->postedAt === null || $this->balanceAfter === null) {
            throw new \LogicException(sprintf(
                'Wallet transaction %s has no complete posting (posted_at/balance_after) to restore',
                $this->reference,
            ));
        }
        $this->status = self::STATUS_SUCCESS;
        $this->mergeMetadata(['restored' => $details]);
    }

    /** @param array<string,mixed> $metadata merged over the existing metadata */
    public function mergeMetadata(array $metadata): void
    {
        $this->setMetadata(array_merge($this->metadata ?? [], $metadata));
    }

    /** @param list<string> $allowed */
    private function guard(array $allowed, string $to): void
    {
        if (!in_array($this->status, $allowed, true)) {
            throw new \LogicException(sprintf(
                'Wallet transaction %s cannot move from %s to %s',
                $this->reference,
                $this->status,
                $to,
            ));
        }
    }

    /** An entry that already moved money never posts, fails or is held again. */
    private function guardNotPosted(string $to): void
    {
        if ($this->wasPosted()) {
            throw new \LogicException(sprintf(
                'Wallet transaction %s already posted (at %s, balance after %s); it cannot move from %s to %s',
                $this->reference,
                $this->postedAt?->format(DATE_ATOM) ?? '?',
                $this->balanceAfter ?? '?',
                $this->status,
                $to,
            ));
        }
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

    /**
     * Label used by the UI: "Top-up", "Paid out", "Refund". An entry that did
     * not post says so ("Top-up · under review"), so the history never shows
     * money as added when it wasn't — nor as missing when it was added.
     */
    public function label(): string
    {
        $label = match ($this->type) {
            self::TYPE_TOPUP        => 'Top-up',
            self::TYPE_CONSULTATION => 'Paid out',
            self::TYPE_REFUND       => 'Refund',
            self::TYPE_REVERSAL     => 'Reversal',
            default                 => 'Adjustment',
        };
        if ($this->isPostedButNotSuccess()) {
            return $label; // its money IS in the wallet (pre-fix row awaiting support's restore)
        }

        return match ($this->status) {
            self::STATUS_PENDING  => $label . ' · pending',
            self::STATUS_FAILED   => $label . ' · not completed',
            self::STATUS_REVIEW   => $label . ' · under review',
            self::STATUS_RESOLVED => $label . ' · resolved by support',
            default               => $label,
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
