<?php

declare(strict_types=1);

namespace App\Domain\Entity;

use DateTimeImmutable;
use Doctrine\ORM\Mapping as ORM;
use DomainException;
use Ramsey\Uuid\Uuid;

/**
 * A card checkout (Paystack) the server started: one row per reference, written
 * BEFORE the reference is ever handed to Paystack, so every card charge has a
 * server-side record whatever happens to the browser afterwards.
 *
 * It says who paid (`patient_id`), for what (`purpose` + `context`: the doctor,
 * the slot, the appointment, ...), how much was expected and — once Paystack
 * confirmed it — how much was actually paid. Its status only moves forward:
 *
 *   initiated ─┬─> paid ─┬─> consumed            (it paid for the thing; consumed_by says which)
 *              │         ├─> credited_to_wallet  (unused: the money went to the patient's wallet)
 *              │         └─> review ─┬─> credited_to_wallet / consumed   (support closed it)
 *              │                     (paid, but it can't be placed automatically — failure_reason says why)
 *              ├─> expired  (never paid within a day; a late success still moves it to paid)
 *              └─> failed   (the checkout never started; same)
 *
 * A reference is used at most once: consuming and crediting both happen under
 * a row lock on this entity ({@see \App\Infrastructure\Service\PaymentIntentService}),
 * so one card payment can never pay for two things, or pay for one and be
 * credited too. Money is decimal strings (bcmath), never floats.
 */
#[ORM\Entity]
#[ORM\Table(name: 'payment_intents')]
#[ORM\UniqueConstraint(name: 'uniq_payment_intents_reference', columns: ['reference'])]
#[ORM\Index(name: 'idx_payment_intents_patient', columns: ['patient_id'])]
#[ORM\Index(name: 'idx_payment_intents_status', columns: ['status', 'created_at'])]
#[ORM\HasLifecycleCallbacks]
class PaymentIntent
{
    use TimestampsTrait;

    public const PURPOSE_BOOKING   = 'appointment_booking';
    public const PURPOSE_FOLLOW_UP = 'follow_up_accept';
    public const PURPOSE_GUEST     = 'guest_add';
    public const PURPOSES          = [self::PURPOSE_BOOKING, self::PURPOSE_FOLLOW_UP, self::PURPOSE_GUEST];

    public const STATUS_INITIATED = 'initiated';
    public const STATUS_PAID      = 'paid';
    public const STATUS_CONSUMED  = 'consumed';
    public const STATUS_CREDITED  = 'credited_to_wallet';
    public const STATUS_EXPIRED   = 'expired';
    public const STATUS_FAILED    = 'failed';
    /** Paid, but nothing may use or credit it automatically (a wallet that can't take it, a pre-intent payment that may have been refunded): support decides. */
    public const STATUS_REVIEW    = 'review';

    /** Statuses a successful Paystack charge may still move to paid (a late success is still money we hold). */
    public const PAYABLE = [self::STATUS_INITIATED, self::STATUS_EXPIRED, self::STATUS_FAILED];

    #[ORM\Id]
    #[ORM\Column(type: 'uuid')]
    private string $id;

    #[ORM\Column(type: 'string', length: 100)]
    private string $reference;

    #[ORM\Column(name: 'patient_id', type: 'uuid')]
    private string $patientId;

    #[ORM\Column(type: 'string', length: 30)]
    private string $purpose;

    /**
     * What it pays for, as the pay-init saw it: specialist_id, scheduled_at,
     * parent_appointment_id, appointment_id, guest_count...
     *
     * @var array<string,mixed>
     */
    #[ORM\Column(type: 'json')]
    private array $context;

    /** What the checkout asked for (major units, e.g. "10000.00"). */
    #[ORM\Column(type: 'decimal', precision: 12, scale: 2)]
    private string $amount;

    #[ORM\Column(type: 'string', length: 3)]
    private string $currency;

    #[ORM\Column(type: 'string', length: 20)]
    private string $status = self::STATUS_INITIATED;

    #[ORM\Column(type: 'string', length: 20, options: ['default' => 'paystack'])]
    private string $provider = 'paystack';

    /** What Paystack says was actually charged — set once, when it is first confirmed. */
    #[ORM\Column(name: 'verified_amount', type: 'decimal', precision: 12, scale: 2, nullable: true)]
    private ?string $verifiedAmount = null;

    #[ORM\Column(name: 'verified_currency', type: 'string', length: 3, nullable: true)]
    private ?string $verifiedCurrency = null;

    #[ORM\Column(name: 'gateway_reference', type: 'string', length: 100, nullable: true)]
    private ?string $gatewayReference = null;

    #[ORM\Column(name: 'paid_at', type: 'datetime_immutable', nullable: true)]
    private ?DateTimeImmutable $paidAt = null;

    /** What it paid for: the appointment id (booking / follow-up) or the guest id. */
    #[ORM\Column(name: 'consumed_by', type: 'string', length: 64, nullable: true)]
    private ?string $consumedBy = null;

    #[ORM\Column(name: 'consumed_at', type: 'datetime_immutable', nullable: true)]
    private ?DateTimeImmutable $consumedAt = null;

    /** Paid above what it was used for — credited to the wallet with the consumption. */
    #[ORM\Column(name: 'overpaid_amount', type: 'decimal', precision: 12, scale: 2, nullable: true)]
    private ?string $overpaidAmount = null;

    #[ORM\Column(name: 'credited_amount', type: 'decimal', precision: 12, scale: 2, nullable: true)]
    private ?string $creditedAmount = null;

    #[ORM\Column(name: 'credited_at', type: 'datetime_immutable', nullable: true)]
    private ?DateTimeImmutable $creditedAt = null;

    /** The wallet-ledger reference the credit posted under. */
    #[ORM\Column(name: 'wallet_reference', type: 'string', length: 120, nullable: true)]
    private ?string $walletReference = null;

    /** When the reconciliation sweep last asked Paystack about it. */
    #[ORM\Column(name: 'last_checked_at', type: 'datetime_immutable', nullable: true)]
    private ?DateTimeImmutable $lastCheckedAt = null;

    #[ORM\Column(name: 'failure_reason', type: 'string', length: 200, nullable: true)]
    private ?string $failureReason = null;

    /** @param array<string,mixed> $context */
    public function __construct(string $reference, string $patientId, string $purpose, array $context, string $amount, string $currency)
    {
        if (!in_array($purpose, self::PURPOSES, true)) {
            throw new DomainException('Unknown payment purpose: ' . $purpose);
        }
        $this->id        = Uuid::uuid4()->toString();
        $this->reference = $reference;
        $this->patientId = $patientId;
        $this->purpose   = $purpose;
        $this->context   = $context;
        $this->amount    = bcadd($amount, '0', 2);
        $this->currency  = strtoupper($currency);
    }

    // ----- State -----

    /** Paystack confirmed the charge: what was paid is recorded once. */
    public function markPaid(string $amount, string $currency, ?string $gatewayReference, DateTimeImmutable $at): void
    {
        if (!in_array($this->status, self::PAYABLE, true)) {
            throw new DomainException(sprintf('Payment %s is %s — it cannot become paid', $this->reference, $this->status));
        }
        $this->status           = self::STATUS_PAID;
        $this->verifiedAmount   = bcadd($amount, '0', 2);
        $this->verifiedCurrency = strtoupper($currency);
        $this->gatewayReference = $gatewayReference;
        $this->paidAt           = $at;
        $this->failureReason    = null;
    }

    /** It paid for `$by` (an appointment or guest id); `$overpaid` went to the wallet. */
    public function markConsumed(string $by, ?string $overpaid, DateTimeImmutable $at): void
    {
        $this->requirePaid('used');
        $this->status         = self::STATUS_CONSUMED;
        $this->consumedBy     = $by;
        $this->consumedAt     = $at;
        $this->overpaidAmount = $overpaid;
    }

    /** It wasn't used: `$amount` was credited to the wallet under `$walletReference`. */
    public function markCredited(string $amount, string $walletReference, DateTimeImmutable $at): void
    {
        $this->requirePaid('credited');
        $this->status          = self::STATUS_CREDITED;
        $this->creditedAmount  = $amount;
        $this->walletReference = $walletReference;
        $this->creditedAt      = $at;
    }

    /** Never paid within the checkout's life (the sweep). */
    public function markExpired(DateTimeImmutable $at): void
    {
        if ($this->status !== self::STATUS_INITIATED) {
            throw new DomainException(sprintf('Payment %s is %s — it cannot expire', $this->reference, $this->status));
        }
        $this->status        = self::STATUS_EXPIRED;
        $this->lastCheckedAt = $at;
    }

    /** The checkout could not start (Paystack refused to initialise it). */
    public function markFailed(string $reason): void
    {
        if ($this->status !== self::STATUS_INITIATED) {
            throw new DomainException(sprintf('Payment %s is %s — it cannot fail', $this->reference, $this->status));
        }
        $this->status        = self::STATUS_FAILED;
        $this->failureReason = mb_substr($reason, 0, 200);
    }

    /**
     * Paid, but it can't be used or credited automatically: held for support
     * (`$reason` says why). Nothing moves money on it until support closes it.
     */
    public function markForReview(string $reason, DateTimeImmutable $at): void
    {
        $this->requirePaid('held for review');
        $this->status        = self::STATUS_REVIEW;
        $this->failureReason = mb_substr($reason, 0, 200);
        $this->lastCheckedAt = $at;
    }

    /** Support closed a review by crediting `$amount` to the wallet under `$walletReference`. */
    public function closeReviewCredited(string $amount, string $walletReference, DateTimeImmutable $at): void
    {
        $this->requireReview();
        $this->status          = self::STATUS_CREDITED;
        $this->creditedAmount  = bcadd($amount, '0', 2);
        $this->walletReference = $walletReference;
        $this->creditedAt      = $at;
    }

    /** Support closed a review with no credit: the money was settled already (`$by` records how). */
    public function closeReviewSettled(string $by, DateTimeImmutable $at): void
    {
        $this->requireReview();
        $this->status     = self::STATUS_CONSUMED;
        $this->consumedBy = mb_substr($by, 0, 64);
        $this->consumedAt = $at;
    }

    public function markChecked(DateTimeImmutable $at): void
    {
        $this->lastCheckedAt = $at;
    }

    private function requireReview(): void
    {
        if ($this->status !== self::STATUS_REVIEW) {
            throw new DomainException(sprintf('Payment %s is %s — it is not held for review', $this->reference, $this->status));
        }
    }

    private function requirePaid(string $as): void
    {
        if ($this->status !== self::STATUS_PAID) {
            throw new DomainException(sprintf('Payment %s is %s — it cannot be %s', $this->reference, $this->status, $as));
        }
    }

    // ----- Rules -----

    /** Paid and not yet used or credited: the money is ours to place. */
    public function isUnusedPaid(): bool
    {
        return $this->status === self::STATUS_PAID;
    }

    /**
     * Whether this checkout was for `$purpose` with every `$expected` context
     * value (string-compared; an expected null means "none" — e.g. a regular
     * booking may not use a follow-up's payment). A payment adopted from
     * before intents existed is held only to what its record knows (the old
     * checkout recorded less, and checked nothing of it).
     *
     * @param array<string,?string> $expected
     */
    public function matches(string $purpose, array $expected): bool
    {
        if ($this->purpose !== $purpose) {
            return false;
        }
        $adopted = ($this->context['adopted'] ?? false) === true;
        foreach ($expected as $key => $value) {
            if ($adopted && !array_key_exists($key, $this->context)) {
                continue;
            }
            $have = $this->context[$key] ?? null;
            $have = $have === null || $have === '' ? null : strtolower(trim((string) $have));
            $want = $value === null || $value === '' ? null : strtolower(trim($value));
            if ($have !== $want) {
                return false;
            }
        }

        return true;
    }

    /** What was paid above `$expected` ("0.00" when nothing), in major units. */
    public function overpaidFor(string $expected): string
    {
        $over = bcsub((string) $this->verifiedAmount, bcadd($expected, '0', 2), 2);

        return bccomp($over, '0', 2) > 0 ? $over : '0.00';
    }

    // ----- Accessors -----

    public function getId(): string
    {
        return $this->id;
    }

    public function getReference(): string
    {
        return $this->reference;
    }

    public function getPatientId(): string
    {
        return $this->patientId;
    }

    public function getPurpose(): string
    {
        return $this->purpose;
    }

    /** @return array<string,mixed> */
    public function getContext(): array
    {
        return $this->context;
    }

    public function contextValue(string $key): ?string
    {
        $value = $this->context[$key] ?? null;

        return $value === null || $value === '' ? null : (string) $value;
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

    public function getVerifiedAmount(): ?string
    {
        return $this->verifiedAmount;
    }

    public function getVerifiedCurrency(): ?string
    {
        return $this->verifiedCurrency;
    }

    public function getGatewayReference(): ?string
    {
        return $this->gatewayReference;
    }

    public function getPaidAt(): ?DateTimeImmutable
    {
        return $this->paidAt;
    }

    public function getConsumedBy(): ?string
    {
        return $this->consumedBy;
    }

    public function getConsumedAt(): ?DateTimeImmutable
    {
        return $this->consumedAt;
    }

    public function getOverpaidAmount(): ?string
    {
        return $this->overpaidAmount;
    }

    public function getCreditedAmount(): ?string
    {
        return $this->creditedAmount;
    }

    public function getCreditedAt(): ?DateTimeImmutable
    {
        return $this->creditedAt;
    }

    public function getWalletReference(): ?string
    {
        return $this->walletReference;
    }

    public function getLastCheckedAt(): ?DateTimeImmutable
    {
        return $this->lastCheckedAt;
    }

    public function getFailureReason(): ?string
    {
        return $this->failureReason;
    }

    /** @return array<string,mixed> */
    public function toArray(): array
    {
        return [
            'id'                => $this->id,
            'reference'         => $this->reference,
            'patient_id'        => $this->patientId,
            'purpose'           => $this->purpose,
            'context'           => $this->context,
            'amount'            => $this->amount,
            'currency'          => $this->currency,
            'status'            => $this->status,
            'verified_amount'   => $this->verifiedAmount,
            'verified_currency' => $this->verifiedCurrency,
            'paid_at'           => $this->paidAt?->format(DATE_ATOM),
            'consumed_by'       => $this->consumedBy,
            'consumed_at'       => $this->consumedAt?->format(DATE_ATOM),
            'overpaid_amount'   => $this->overpaidAmount,
            'credited_amount'   => $this->creditedAmount,
            'credited_at'       => $this->creditedAt?->format(DATE_ATOM),
            'created_at'        => $this->createdAt->format(DATE_ATOM),
        ];
    }
}
