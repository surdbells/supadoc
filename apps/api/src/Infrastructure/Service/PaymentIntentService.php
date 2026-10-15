<?php

declare(strict_types=1);

namespace App\Infrastructure\Service;

use App\Domain\Entity\Patient;
use App\Domain\Entity\PaymentIntent;
use App\Domain\Entity\WalletTransaction;
use App\Domain\Enum\NotificationType;
use App\Domain\Exception\LedgerReferenceConflictException;
use App\Domain\Exception\ValidationException;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\PatientRepository;
use App\Domain\Repository\PaymentIntentRepository;
use App\Domain\Repository\WalletTransactionRepository;
use App\Infrastructure\Email\WalletMailer;
use DateTimeImmutable;
use Doctrine\DBAL\Exception\UniqueConstraintViolationException;
use Ramsey\Uuid\Uuid;

/**
 * Card payments (Paystack) end to end, on one {@see PaymentIntent} per
 * reference:
 *
 *  - {@see create()} at pay-init — before the reference is handed to Paystack;
 *  - {@see consume()} when the payment is used: inside the SAME transaction as
 *    the booking / follow-up acceptance / guest it pays for, under a row lock
 *    on the intent, so one payment pays for one thing, once — a second use is
 *    refused ("This payment has already been used") with no money moved. It
 *    asks Paystack once (the answer is kept on the intent), requires the
 *    payer, purpose and context to match and the amount and currency to cover
 *    the price, and credits anything paid above the price to the wallet;
 *  - {@see settleUnused()} credits a paid payment nothing used to the
 *    patient's wallet (idempotent, under the same lock — never both used and
 *    credited); one that can't be credited automatically is held for review;
 *  - {@see recordCharge()} for the webhook's charge.success, and {@see sweep()}
 *    for the cron: a charge whose webhook never came is found by asking
 *    Paystack, and an unused one is credited after CARD_INTENT_CREDIT_AFTER_MINUTES.
 *
 * Every money move is audited (`payment.card_*`) in the same transaction as
 * the state change it records, and the patient is told in-app when money
 * reaches their wallet.
 */
final class PaymentIntentService
{
    public const REFERENCE_PREFIX = 'vma_';
    /** An initiated checkout is re-checked with Paystack once it is this old (and again this often, for its first {@see REVERIFY_SLOW_AFTER_HOURS} hours). */
    public const REVERIFY_AFTER_MINUTES = 15;
    /** Older than this, an unconfirmed checkout (most likely abandoned) is re-checked only this often. */
    public const REVERIFY_SLOW_AFTER_HOURS = 2;
    /** An initiated checkout never paid within this long expires (a late success still counts). */
    public const EXPIRE_AFTER_HOURS = 24;
    public const DEFAULT_CREDIT_AFTER_MINUTES = 30;
    /**
     * A pre-intent `vma_` payment is adopted automatically only if it was paid
     * no earlier than this long before the first checkout was recorded (≈ the
     * deploy): one in flight across the deploy. Anything older is support's.
     */
    public const LEGACY_ADOPT_WINDOW_HOURS = 24;

    public const ALREADY_IN_WALLET = 'This payment is already in your wallet — pay from your wallet instead.';
    public const ALREADY_USED      = 'This payment has already been used.';
    public const NOT_FOUND         = "We couldn't find this card payment. If you were charged, contact support with its reference.";
    public const NOT_YOURS         = "This payment can't be used here.";
    public const OTHER_PURPOSE     = "This card payment was made for something else, so it can't be used here.";
    public const VERIFY_FAILED     = 'We could not verify your card payment. Please try again.';
    public const NOT_COMPLETED     = 'Your card payment was not completed.';
    public const WRONG_CURRENCY    = 'The payment currency does not match. Please contact support.';
    public const UNDERPAID         = 'The amount paid does not cover this consultation.';
    public const UNDER_REVIEW      = "This card payment is being checked by our support team, so it can't be used yet. Contact support with its reference if you need help.";
    public const LEGACY_SUPPORT    = "This card payment was made before our latest update and can't be used automatically. Contact support with its reference and we'll sort it out.";
    public const TOPUP_PENDING     = "This is a wallet top-up that is still being confirmed, so it can't pay for this. It is added to your wallet once Paystack confirms it.";
    public const TOPUP_NOT_CREDITED = "This wallet top-up hasn't been added to your wallet, so it can't pay for this. Check your wallet, or contact support with its reference.";

    /** What Paystack metadata called each purpose before payment intents existed (legacy adoption). */
    private const LEGACY_PURPOSES = [
        'appointment_booking'  => PaymentIntent::PURPOSE_BOOKING,
        'follow_up_acceptance' => PaymentIntent::PURPOSE_FOLLOW_UP,
        'follow_up_accept'     => PaymentIntent::PURPOSE_FOLLOW_UP,
        'guest_invite'         => PaymentIntent::PURPOSE_GUEST,
        'guest_add'            => PaymentIntent::PURPOSE_GUEST,
    ];

    private readonly int $creditAfterMinutes;

    /**
     * Wallet credits posted inside the transaction now running, whose receipts
     * go out once it commits ({@see inTransaction()}).
     *
     * @var list<WalletTransaction>
     */
    private array $receipts = [];

    public function __construct(
        private readonly PaymentIntentRepository $intents,
        private readonly CardPaymentGateway $gateway,
        private readonly WalletService $wallets,
        private readonly PatientRepository $patients,
        private readonly AppointmentRepository $appointments,
        private readonly PatientNotifier $notifier,
        private readonly AuditLogger $audit,
        private readonly WalletMailer $mailer,
        private readonly WalletTransactionRepository $ledger,
        int $creditAfterMinutes = self::DEFAULT_CREDIT_AFTER_MINUTES,
    ) {
        $this->creditAfterMinutes = max(1, $creditAfterMinutes);
    }

    public function creditAfterMinutes(): int
    {
        return $this->creditAfterMinutes;
    }

    public static function newReference(): string
    {
        return self::REFERENCE_PREFIX . bin2hex(random_bytes(12));
    }

    /**
     * The wallet-ledger reference an unused card payment is credited under —
     * once per payment. (The `fu_` prefix predates intents: credits posted
     * before them used the same key, so none can be posted twice.)
     */
    public static function walletCreditKey(string $reference): string
    {
        return 'fu_card_credit_' . $reference;
    }

    /** The wallet-ledger reference of what a used card payment paid above the price. */
    public static function overpaymentKey(string $reference): string
    {
        return 'card_overpay_' . $reference;
    }

    /**
     * Whether a gateway status means the charge may still succeed (pending,
     * ongoing, processing, an unknown word, or no transaction found yet) —
     * as opposed to success or a final failure.
     */
    public static function isStillOpen(string $gatewayStatus): bool
    {
        $status = strtolower(trim($gatewayStatus));

        return $status !== 'success' && !in_array($status, CardPaymentGateway::FINAL_UNPAID, true);
    }

    // ----- pay-init -----

    /**
     * Record a checkout before its reference goes to Paystack.
     *
     * @param array<string,mixed> $context
     */
    public function create(string $patientId, string $purpose, array $context, string $amount, string $currency): PaymentIntent
    {
        $intent = new PaymentIntent(self::newReference(), $patientId, $purpose, $context, $amount, $currency);
        $this->intents->save($intent);

        return $intent;
    }

    /** Paystack refused to start the checkout: the intent can never be paid through it. */
    public function markInitFailed(PaymentIntent $intent, string $reason): void
    {
        if ($intent->getStatus() === PaymentIntent::STATUS_INITIATED) {
            $intent->markFailed($reason);
            $this->intents->save($intent);
        }
    }

    // ----- Paystack's answer -----

    /**
     * Ask Paystack about a checkout that isn't known to be paid yet and record
     * a success (compare-and-set: the webhook, the sweep and a confirming
     * request write it once — and the `payment.card_paid` audit is written in
     * the same transaction as the status change, so a recorded payment is
     * always an audited one). Returns the intent as the database has it now.
     *
     * @throws \RuntimeException when Paystack can't be asked right now
     */
    public function confirmWithGateway(PaymentIntent $intent, ?DateTimeImmutable $now = null): PaymentIntent
    {
        return $this->askGateway($intent, $now)[0];
    }

    /**
     * {@see confirmWithGateway()}, also handing back Paystack's status word
     * (null when Paystack wasn't asked: the intent was past payable).
     *
     * @return array{0: PaymentIntent, 1: ?string}
     */
    private function askGateway(PaymentIntent $intent, ?DateTimeImmutable $now = null): array
    {
        if (!in_array($intent->getStatus(), PaymentIntent::PAYABLE, true)) {
            return [$intent, null];
        }
        $now ??= new DateTimeImmutable();
        $tx = $this->gateway->verify($intent->getReference());
        if ($tx['status'] === 'success' && $tx['amount_minor'] > 0) {
            $amount = self::fromMinor($tx['amount_minor']);
            $this->intents->transactional(function () use ($intent, $tx, $amount, $now): void {
                if (!$this->intents->markPaid($intent->getReference(), $amount, $tx['currency'], $tx['gateway_reference'], $now)) {
                    return; // recorded a moment ago by the webhook / the sweep / another request
                }
                $this->audit->record('Paystack', 'system', 'payment.card_paid', $intent->contextValue('appointment_id'), 'payment_intent', $intent->getId(), [
                    'reference' => $intent->getReference(),
                    'purpose'   => $intent->getPurpose(),
                    'amount'    => $amount,
                    'currency'  => strtoupper($tx['currency']),
                    'expected'  => $intent->getAmount(),
                    'paid_at'   => $tx['paid_at'] ?? null,
                ], $intent->getPatientId());
            });
        }

        return [$this->intents->byReference($intent->getReference()) ?? $intent, (string) $tx['status']];
    }

    // ----- Using a payment -----

    /**
     * Use card payment `$reference` for `$purpose` — the patient `$ownerId`'s,
     * for exactly this (`$context`: e.g. the doctor, the proposal, the
     * appointment) and covering `$expectedAmount` — inside the same transaction
     * as the write it pays for: `$insideTransaction($intent)` runs with the
     * intent's row locked and answers with a {@see PaymentUse}. Used → the
     * intent is consumed by it (anything paid above the price goes to the
     * wallet, in the same transaction); declined → the payment stays unused,
     * or goes to the wallet now when the decline asks for it.
     *
     * Paystack is asked at most once per payment (its answer is kept on the
     * intent), and never while a lock is held. A `vma_` reference from before
     * intents existed is adopted first ({@see adoptForUse()}) — only the
     * payer's own, for what it was paid for, and only one paid around the deploy.
     *
     * @param callable(PaymentIntent): PaymentUse $insideTransaction must hand a refusal back, not throw it
     * @param array<string,?string>               $context
     * @throws ValidationException (422) when the payment can't pay for this — no money moved
     */
    public function consume(string $reference, string $purpose, string $ownerId, string $expectedAmount, callable $insideTransaction, array $context = []): PaymentUse
    {
        $reference = trim($reference);
        $intent    = $reference !== '' ? $this->intents->byReference($reference) : null;
        if ($intent === null) {
            $this->refuseLedgerReference($reference, $ownerId); // a wallet top-up's reference
            $intent = $this->adoptForUse($reference, $ownerId, $purpose) ?? throw self::refusal(self::NOT_FOUND);
        }
        if ($intent->getPatientId() !== $ownerId) {
            throw self::refusal(self::NOT_YOURS);
        }
        self::refuseSettled($intent->getStatus());
        if (!$intent->matches($purpose, $context)) {
            throw self::refusal(self::OTHER_PURPOSE . $this->autoCreditNote($intent));
        }

        if (!$intent->isUnusedPaid()) {
            try {
                $intent = $this->confirmWithGateway($intent);
            } catch (\Throwable $e) {
                error_log('[payments.consume] card verify failed (ref=' . $reference . '): ' . $e->getMessage());
                throw self::refusal(self::VERIFY_FAILED);
            }
            self::refuseSettled($intent->getStatus());
            if (!$intent->isUnusedPaid()) {
                throw self::refusal(self::NOT_COMPLETED);
            }
        }
        if ($intent->getVerifiedCurrency() !== $intent->getCurrency()) {
            error_log(sprintf('[payments.consume] currency mismatch (ref=%s): paid %s, expected %s', $reference, (string) $intent->getVerifiedCurrency(), $intent->getCurrency()));
            throw self::refusal(self::WRONG_CURRENCY);
        }
        if (bccomp((string) $intent->getVerifiedAmount(), bcadd($expectedAmount, '0', 2), 2) < 0) {
            throw self::refusal(self::UNDERPAID . $this->autoCreditNote($intent));
        }

        $now     = new DateTimeImmutable();
        $outcome = $this->inTransaction(function () use ($intent, $insideTransaction, $expectedAmount, $now): PaymentUse|string {
            $this->intents->lock($intent);
            if (!$intent->isUnusedPaid()) {
                return $intent->getStatus(); // used or credited by a request that got here first
            }
            $use = $insideTransaction($intent);
            if (!$use instanceof PaymentUse) {
                throw new \LogicException('A card payment callback must answer with a PaymentUse');
            }
            if (!$use->used) {
                return $use->creditToWallet ? $use->withCredited($this->creditLocked($intent, $now, 'declined')) : $use;
            }

            $over     = $intent->overpaidFor($expectedAmount);
            $overpaid = bccomp($over, '0', 2) > 0 ? $over : null;
            $intent->markConsumed((string) $use->usedBy, $overpaid, $now);
            if ($overpaid !== null) {
                $this->creditWallet(
                    $intent->getPatientId(),
                    (string) $intent->getVerifiedCurrency(),
                    $overpaid,
                    self::overpaymentKey($intent->getReference()),
                    'Card payment above the price — returned to your wallet',
                );
            }
            $this->audit->record('Patient', 'patient', 'payment.card_consumed', $this->appointmentOf($intent, $use), 'payment_intent', $intent->getId(), [
                'reference'   => $intent->getReference(),
                'purpose'     => $intent->getPurpose(),
                'consumed_by' => $use->usedBy,
                'paid'        => $intent->getVerifiedAmount(),
                'price'       => bcadd($expectedAmount, '0', 2),
                'overpaid'    => $overpaid,
                'currency'    => $intent->getVerifiedCurrency(),
            ], $intent->getPatientId());

            return $use->withOverpaidCredited($overpaid);
        });
        if (is_string($outcome)) {
            self::refuseSettled($outcome);
            throw self::refusal(self::ALREADY_USED);
        }

        if ($outcome->credited !== null) {
            $this->notifyCredited($intent, $outcome->credited);
        }
        if ($outcome->overpaidCredited !== null) {
            $this->notify(
                $intent->getPatientId(),
                'Extra payment returned to your wallet',
                sprintf('You paid %s more than the price, so we added it to your VideoMed wallet.', $this->money($outcome->overpaidCredited, $intent->getCurrency())),
            );
        }

        return $outcome;
    }

    /**
     * What the patient `$ownerId`'s card payment `$reference` already paid for
     * as `$purpose` (an appointment or guest id), or null when it hasn't paid
     * for anything (or isn't theirs) — so a repeated request can be answered
     * with what the first one did instead of a refusal.
     */
    public function usedFor(string $reference, string $ownerId, string $purpose): ?string
    {
        $reference = trim($reference);
        $intent    = $reference !== '' ? $this->intents->byReference($reference) : null;
        if ($intent === null || $intent->getPatientId() !== $ownerId || $intent->getPurpose() !== $purpose || $intent->getStatus() !== PaymentIntent::STATUS_CONSUMED) {
            return null;
        }

        return $intent->getConsumedBy();
    }

    /**
     * Where the patient `$ownerId`'s card payment `$reference` stands, for the
     * app (e.g. offering "Complete your paid booking" after a reload only for
     * a payment that was really made). A checkout not yet known to be paid is
     * checked with Paystack first. Null when there is no such payment of theirs.
     *
     * `status`: `not_paid` (nothing was charged, as far as Paystack says),
     * `unconfirmed` (Paystack couldn't be asked just now), `paid` (paid and
     * not used yet — it can still pay for what it was made for; otherwise it is
     * credited to the wallet at `credit_due_at`), `used`, `credited_to_wallet`,
     * `review` (held for support).
     *
     * @return array<string,mixed>|null
     */
    public function statusFor(string $reference, string $ownerId): ?array
    {
        $reference = trim($reference);
        $intent    = $reference !== '' && strlen($reference) <= 100 ? $this->intents->byReference($reference) : null;
        if ($intent === null || $intent->getPatientId() !== $ownerId) {
            return null;
        }
        $unconfirmed = false;
        if (in_array($intent->getStatus(), PaymentIntent::PAYABLE, true)) {
            try {
                $intent = $this->confirmWithGateway($intent);
            } catch (\Throwable $e) {
                error_log('[payments.status] card verify failed (ref=' . $reference . '): ' . $e->getMessage());
                $unconfirmed = true;
            }
        }

        $status = match ($intent->getStatus()) {
            PaymentIntent::STATUS_PAID     => 'paid',
            PaymentIntent::STATUS_CONSUMED => 'used',
            PaymentIntent::STATUS_CREDITED => 'credited_to_wallet',
            PaymentIntent::STATUS_REVIEW   => 'review',
            default                        => $unconfirmed ? 'unconfirmed' : 'not_paid',
        };

        return [
            'reference'             => $intent->getReference(),
            'status'                => $status,
            'purpose'               => $intent->getPurpose(),
            'amount'                => $intent->getVerifiedAmount() ?? $intent->getAmount(),
            'currency'              => $intent->getVerifiedCurrency() ?? $intent->getCurrency(),
            'specialist_id'         => $intent->contextValue('specialist_id'),
            'used_for'              => $status === 'used' && $intent->getPurpose() !== PaymentIntent::PURPOSE_GUEST ? $intent->getConsumedBy() : null,
            'credited_amount'       => $intent->getCreditedAmount(),
            'credit_due_at'         => $status === 'paid' && $intent->getPaidAt() !== null
                ? $intent->getPaidAt()->modify('+' . $this->creditAfterMinutes . ' minutes')->format(DATE_ATOM)
                : null,
            'credit_after_minutes'  => $this->creditAfterMinutes,
        ];
    }

    // ----- Unused payments → the wallet -----

    /**
     * Credit card payment `$reference` to its patient's wallet if it was paid
     * and nothing used it (asking Paystack first when it isn't known to be
     * paid). Idempotent, and never both used and credited: the credit happens
     * under the intent's row lock, and a consumption that got there first wins.
     * Returns the amount credited, or null when there was nothing to credit
     * (unknown, not paid, used, credited already, held for review, or Paystack
     * unreachable).
     */
    public function settleUnused(string $reference): ?string
    {
        return $this->settle($reference)['credited'];
    }

    /**
     * {@see settleUnused()}, saying also whether the payment was held for
     * review instead (it can't be credited automatically).
     *
     * @return array{credited: ?string, review: bool}
     */
    private function settle(string $reference): array
    {
        $none   = ['credited' => null, 'review' => false];
        $intent = $this->intents->byReference(trim($reference));
        if ($intent === null) {
            return $none;
        }
        $now = new DateTimeImmutable();
        if (in_array($intent->getStatus(), PaymentIntent::PAYABLE, true)) {
            try {
                $intent = $this->confirmWithGateway($intent, $now);
            } catch (\Throwable $e) {
                error_log('[payments.settle] card verify failed (ref=' . $reference . '): ' . $e->getMessage());

                return $none;
            }
        }
        if (!$intent->isUnusedPaid()) {
            return $none;
        }

        $credited = $this->inTransaction(function () use ($intent, $now): ?string {
            $this->intents->lock($intent);

            return $intent->isUnusedPaid() ? $this->creditLocked($intent, $now, 'unused') : null;
        });
        if ($credited !== null) {
            $this->notifyCredited($intent, $credited);
        }

        return ['credited' => $credited, 'review' => $credited === null && $intent->getStatus() === PaymentIntent::STATUS_REVIEW];
    }

    /**
     * {@see settleUnused()} for a refusal that knows what the payment was for:
     * only the patient `$ownerId`'s payment for `$purpose` / `$context` is
     * credited now (anything else is left for the sweep).
     *
     * @param array<string,?string> $context
     */
    public function settleUnusedFor(string $reference, string $ownerId, string $purpose, array $context): ?string
    {
        $reference = trim($reference);
        $intent    = $reference !== '' ? $this->intents->byReference($reference) : null;
        if ($intent === null || $intent->getPatientId() !== $ownerId || !$intent->matches($purpose, $context)) {
            return null;
        }

        return $this->settleUnused($reference);
    }

    /**
     * Credit the locked, paid, unused `$intent` to the wallet (call inside its
     * transaction, under the lock). The posting is idempotent on
     * {@see walletCreditKey()}. One that can never be posted automatically —
     * nothing to credit, a currency the wallet doesn't hold, or the key already
     * holding a different posting — is held for review (status `review`, the
     * reason kept and audited): it leaves the sweep's queue, and support decides.
     */
    private function creditLocked(PaymentIntent $intent, DateTimeImmutable $now, string $why): ?string
    {
        $amount   = (string) $intent->getVerifiedAmount();
        $currency = (string) $intent->getVerifiedCurrency();
        $key      = self::walletCreditKey($intent->getReference());
        if (bccomp($amount, '0', 2) <= 0 || !$this->wallets->isSupported($currency)) {
            $this->holdLocked($intent, $now, sprintf('cannot credit %s %s automatically (amount or currency)', $currency, $amount));

            return null;
        }
        try {
            $this->creditWallet($intent->getPatientId(), $currency, $amount, $key, self::creditDescription($intent));
        } catch (LedgerReferenceConflictException $e) {
            // WalletService refuses after its own (empty) transaction ended, so ours goes on.
            $this->holdLocked($intent, $now, 'wallet key ' . $key . ' already holds a different posting');

            return null;
        }
        $intent->markCredited($amount, $key, $now);
        $this->audit->record('System', 'system', 'payment.card_credited_to_wallet', $intent->contextValue('appointment_id'), 'payment_intent', $intent->getId(), [
            'reference'        => $intent->getReference(),
            'purpose'          => $intent->getPurpose(),
            'amount'           => $amount,
            'currency'         => $currency,
            'wallet_reference' => $key,
            'why'              => $why,
        ], $intent->getPatientId());

        return $amount;
    }

    /** Hold the locked, paid `$intent` for review (in the running transaction), audited and logged. */
    private function holdLocked(PaymentIntent $intent, DateTimeImmutable $now, string $reason): void
    {
        $intent->markForReview($reason, $now);
        $this->audit->record('System', 'system', 'payment.card_held_for_review', $intent->contextValue('appointment_id'), 'payment_intent', $intent->getId(), [
            'reference' => $intent->getReference(),
            'purpose'   => $intent->getPurpose(),
            'amount'    => $intent->getVerifiedAmount(),
            'currency'  => $intent->getVerifiedCurrency(),
            'reason'    => $reason,
        ], $intent->getPatientId());
        error_log(sprintf('[payments.credit] %s held for review: %s', $intent->getReference(), $reason));
    }

    /**
     * Support closes a payment held for review: `$creditAmount` credits that
     * much to the patient's wallet (under {@see walletCreditKey()}, once);
     * null closes it with no credit (the money was settled another way —
     * `$note` says how). Under the payment's row lock; audited. Returns the
     * intent as closed, or null when it isn't (or no longer) held for review.
     */
    public function closeReview(string $reference, ?string $creditAmount, string $note, string $actorName): ?PaymentIntent
    {
        $intent = $this->intents->byReference(trim($reference));
        if ($intent === null || $intent->getStatus() !== PaymentIntent::STATUS_REVIEW) {
            return null;
        }
        $now    = new DateTimeImmutable();
        $closed = $this->inTransaction(function () use ($intent, $creditAmount, $note, $actorName, $now): bool {
            $this->intents->lock($intent);
            if ($intent->getStatus() !== PaymentIntent::STATUS_REVIEW) {
                return false;
            }
            $key = self::walletCreditKey($intent->getReference());
            if ($creditAmount !== null) {
                $amount = bcadd($creditAmount, '0', 2);
                if (bccomp($amount, '0', 2) <= 0) {
                    throw new \InvalidArgumentException('A credit must be positive');
                }
                $this->creditWallet($intent->getPatientId(), (string) ($intent->getVerifiedCurrency() ?? $intent->getCurrency()), $amount, $key, self::creditDescription($intent));
                $intent->closeReviewCredited($amount, $key, $now);
            } else {
                $intent->closeReviewSettled('support', $now);
            }
            $this->audit->record($actorName, 'admin', 'payment.card_review_closed', $intent->contextValue('appointment_id'), 'payment_intent', $intent->getId(), [
                'reference' => $intent->getReference(),
                'credited'  => $creditAmount !== null ? bcadd($creditAmount, '0', 2) : null,
                'note'      => mb_substr($note, 0, 500),
            ]);

            return true;
        });
        if (!$closed) {
            return null;
        }
        if ($creditAmount !== null) {
            $this->notifyCredited($intent, bcadd($creditAmount, '0', 2));
        }

        return $intent;
    }

    /**
     * Credit the wallet inside the running {@see inTransaction()} (idempotent
     * on `$key`). The receipt email waits for the commit: no mail call while
     * the payment's and the doctor's locks are held, and none for a credit
     * that rolls back. A key posted before (an earlier, pre-intent credit)
     * posts nothing and sends no second receipt.
     */
    private function creditWallet(string $patientId, string $currency, string $amount, string $key, string $description): WalletTransaction
    {
        $fresh = !$this->wallets->hasPosting($key);
        $txn   = $this->wallets->credit($patientId, $currency, $amount, WalletTransaction::TYPE_REFUND, $key, $description, false);
        if ($fresh) {
            $this->receipts[] = $txn;
        }

        return $txn;
    }

    /**
     * {@see PaymentIntentRepository::transactional()}, then the receipts of
     * the wallet credits it committed ({@see creditWallet()}).
     *
     * @template T
     * @param callable(): T $work
     * @return T
     */
    private function inTransaction(callable $work): mixed
    {
        $this->receipts = [];
        try {
            $result = $this->intents->transactional($work);
        } finally {
            $receipts       = $this->receipts;
            $this->receipts = [];
        }
        foreach ($receipts as $txn) {
            $this->mailer->sendReceipt($txn); // never throws: a missing receipt isn't fatal
        }

        return $result;
    }

    // ----- Webhook + reconciliation -----

    /**
     * Paystack's charge.success for `$reference` (signature already checked by
     * the caller): the checkout is confirmed with Paystack and marked paid —
     * it is then used by the patient's request, or credited by the sweep.
     * Idempotent. A pre-intent `vma_` reference (in flight when intents were
     * deployed) is adopted from the payment's own metadata, unless it was
     * already used or credited under the old code, or paid long before.
     *
     * @param array<string,mixed> $metadata the event's `data.metadata` (used when Paystack's verify carries none)
     * @return string paid | already | not_paid | pending | adopted | unknown | too_old — `pending`: Paystack
     *                doesn't call it final yet (the webhook answers 5xx so the event comes again)
     * @throws \RuntimeException when Paystack can't be asked right now (the webhook answers 5xx so it is retried)
     */
    public function recordCharge(string $reference, array $metadata = []): string
    {
        $intent = $this->intents->byReference($reference);
        if ($intent === null) {
            return $this->adoptLegacy($reference, $metadata);
        }
        if (!in_array($intent->getStatus(), PaymentIntent::PAYABLE, true)) {
            return 'already';
        }
        [$intent, $gatewayStatus] = $this->askGateway($intent);
        if ($intent->isUnusedPaid()) {
            return 'paid';
        }
        if (!in_array($intent->getStatus(), PaymentIntent::PAYABLE, true)) {
            return 'already';
        }

        return $gatewayStatus !== null && self::isStillOpen($gatewayStatus) ? 'pending' : 'not_paid';
    }

    /** @param array<string,mixed> $eventMetadata */
    private function adoptLegacy(string $reference, array $eventMetadata): string
    {
        if (!str_starts_with($reference, self::REFERENCE_PREFIX)) {
            return 'unknown';
        }
        $tx = $this->gateway->verify($reference);
        if ($tx['status'] !== 'success' || $tx['amount_minor'] <= 0) {
            return self::isStillOpen((string) $tx['status']) ? 'pending' : 'not_paid';
        }
        // What the checkout recorded with Paystack; the signed event carries the same.
        $metadata  = ($tx['metadata'] ?? []) !== [] ? (array) $tx['metadata'] : $eventMetadata;
        $patientId = (string) ($metadata['patient_id'] ?? '');
        $purpose   = self::LEGACY_PURPOSES[(string) ($metadata['purpose'] ?? '')] ?? null;
        if ($purpose === null || !Uuid::isValid($patientId) || !$this->patients->find($patientId) instanceof Patient) {
            return 'unknown';
        }
        if (($late = $this->outsideAdoptionWindow($tx)) !== null) {
            error_log(sprintf('[payments.adopt] NOT adopted %s (webhook): %s — support: see DEPLOY.md (card charges orphaned before this release)', $reference, $late));

            return 'too_old';
        }

        // null: another delivery adopted it a moment ago
        return $this->adopt($reference, $patientId, $purpose, self::legacyContext($metadata), $tx, 'Paystack') !== null ? 'adopted' : 'already';
    }

    /**
     * A pre-intent `vma_` reference the patient `$ownerId` confirms (pay-init
     * ran on the old code, the confirmation on this one — and its webhook may
     * have gone to the old code, which ignored it). Adopted only when Paystack
     * shows it paid in a wallet currency, BY this patient (`metadata.patient_id`)
     * FOR this purpose (`metadata.purpose`), and paid around the deploy — never
     * an older payment the old code may already have settled in a way that left
     * no trace on the reference (support handles those). What it was paid for
     * (doctor, proposal, appointment) comes from Paystack's record, never from
     * the request. Null when Paystack shows nothing paid under it.
     *
     * @throws ValidationException when it can't be adopted for this, or Paystack can't be asked
     */
    private function adoptForUse(string $reference, string $ownerId, string $purpose): ?PaymentIntent
    {
        if (!str_starts_with($reference, self::REFERENCE_PREFIX) || !Uuid::isValid($ownerId)) {
            return null;
        }
        try {
            $tx = $this->gateway->verify($reference);
        } catch (\Throwable $e) {
            error_log('[payments.consume] card verify failed (ref=' . $reference . '): ' . $e->getMessage());
            throw self::refusal(self::VERIFY_FAILED);
        }
        if ($tx['status'] !== 'success' || $tx['amount_minor'] <= 0) {
            return null;
        }
        $metadata = (array) ($tx['metadata'] ?? []);
        $payer    = strtolower(trim((string) ($metadata['patient_id'] ?? '')));
        if ($payer === '') {
            error_log(sprintf('[payments.adopt] NOT adopted %s: Paystack has no patient on it', $reference));
            throw self::refusal(self::LEGACY_SUPPORT);
        }
        if ($payer !== strtolower($ownerId)) {
            error_log(sprintf('[payments.adopt] NOT adopted %s: paid by patient %s, offered by %s', $reference, $payer, $ownerId));
            throw self::refusal(self::NOT_YOURS);
        }
        if ((self::LEGACY_PURPOSES[(string) ($metadata['purpose'] ?? '')] ?? null) !== $purpose) {
            throw self::refusal(self::OTHER_PURPOSE);
        }
        if (!$this->wallets->isSupported($tx['currency'])) {
            throw self::refusal(self::WRONG_CURRENCY);
        }
        if (($late = $this->outsideAdoptionWindow($tx)) !== null) {
            error_log(sprintf('[payments.adopt] NOT adopted %s: %s — support: see DEPLOY.md (card charges orphaned before this release)', $reference, $late));
            throw self::refusal(self::LEGACY_SUPPORT);
        }

        // null: a concurrent confirmation adopted it a moment ago — trying again finds it.
        return $this->adopt($reference, $ownerId, $purpose, self::legacyContext($metadata), $tx, 'Patient')
            ?? throw self::refusal(self::VERIFY_FAILED);
    }

    /**
     * Why a verified pre-intent payment is too old to adopt automatically, or
     * null when it was paid around the deploy: no earlier than
     * {@see LEGACY_ADOPT_WINDOW_HOURS} before the first checkout this code
     * recorded (or before now, when there is none yet). A payment with no
     * readable payment time is not adopted either.
     *
     * @param array<string,mixed> $tx
     */
    private function outsideAdoptionWindow(array $tx): ?string
    {
        try {
            $paidAt = is_string($tx['paid_at'] ?? null) && $tx['paid_at'] !== '' ? new DateTimeImmutable($tx['paid_at']) : null;
        } catch (\Throwable) {
            $paidAt = null;
        }
        if ($paidAt === null) {
            return 'Paystack gives no payment time';
        }
        $since = ($this->intents->firstRecordedAt() ?? new DateTimeImmutable())->modify('-' . self::LEGACY_ADOPT_WINDOW_HOURS . ' hours');

        return $paidAt < $since ? sprintf('paid %s, before the adoption window (%s)', $paidAt->format(DATE_ATOM), $since->format(DATE_ATOM)) : null;
    }

    /**
     * The context a pre-intent payment's metadata recorded (what its checkout
     * was for).
     *
     * @param array<string,mixed> $metadata
     * @return array<string,string>
     */
    private static function legacyContext(array $metadata): array
    {
        $context = [];
        foreach (['specialist_id', 'appointment_id', 'parent_appointment_id', 'scheduled_at'] as $key) {
            $value = is_scalar($metadata[$key] ?? null) ? trim((string) $metadata[$key]) : '';
            // Ids are kept only when they are ids (they are compared, and audited into uuid columns).
            if ($value !== '' && ($key === 'scheduled_at' || Uuid::isValid($value))) {
                $context[$key] = $value;
            }
        }

        return $context;
    }

    /**
     * Record a pre-intent reference Paystack confirmed as a paid intent —
     * consumed / credited already when the old code used it for a booking or
     * a guest, or credited it to the wallet (so it is never paid out twice);
     * held for review when it was a guest payment on an appointment that had a
     * guest removed (the old code kept the reference only on the guest entry,
     * which removal deletes — its fee may have been refunded already). The
     * intent and its audit are written in one transaction. Null when another
     * request recorded it first.
     *
     * @param array<string,string> $context
     * @param array<string,mixed>  $tx
     */
    private function adopt(string $reference, string $patientId, string $purpose, array $context, array $tx, string $by): ?PaymentIntent
    {
        $now    = new DateTimeImmutable();
        $amount = self::fromMinor((int) $tx['amount_minor']);
        $intent = new PaymentIntent($reference, $patientId, $purpose, ['adopted' => true] + $context, $amount, (string) $tx['currency']);
        $intent->markPaid($amount, (string) $tx['currency'], $tx['gateway_reference'] ?? null, $now);
        // Settled under the old code already: recorded as such, never paid out again.
        $appointmentId = $context['appointment_id'] ?? null;
        if ($this->appointments->existsByPaymentReference($reference)) {
            $intent->markConsumed('legacy', null, $now);
        } elseif ($this->wallets->hasPosting(self::walletCreditKey($reference))) {
            $intent->markCredited($amount, self::walletCreditKey($reference), $now);
        } elseif ($purpose === PaymentIntent::PURPOSE_GUEST && ($appointmentId === null || !Uuid::isValid($appointmentId) || $this->intents->guestRemovedFrom($appointmentId))) {
            $intent->markForReview('pre-intent guest payment; a guest of its appointment was removed (and may have been refunded) — check before crediting', $now);
        }
        try {
            $this->intents->transactional(function () use ($intent, $by, $reference, $purpose, $amount, $patientId): void {
                $this->intents->save($intent);
                $this->audit->record($by, $by === 'Patient' ? 'patient' : 'system', 'payment.card_adopted', $intent->contextValue('appointment_id'), 'payment_intent', $intent->getId(), [
                    'reference' => $reference,
                    'purpose'   => $purpose,
                    'amount'    => $amount,
                    'status'    => $intent->getStatus(),
                    'reason'    => $intent->getFailureReason(),
                ], $patientId);
            });
        } catch (UniqueConstraintViolationException) {
            return null;
        }

        return $intent;
    }

    /**
     * The cron's reconciliation pass: initiated checkouts over 15 minutes old
     * are re-checked with Paystack (every 15 minutes during their first two
     * hours, every two hours after that; expired after a day unpaid), and
     * paid ones nothing used for
     * CARD_INTENT_CREDIT_AFTER_MINUTES are credited to the wallet (the patient
     * is told) — or held for review when they can't be. A failure on one is
     * counted, the payment moves to the back of its queue (so failures can't
     * crowd out the rest), and the rest go on; a checkout Paystack keeps
     * failing on still expires after a day. When a failure leaves the entity
     * manager closed the pass stops (`em_closed`) — the caller re-runs on a
     * fresh one, skipping `failed_refs`.
     *
     * @param list<string> $skip
     * @return array{reverified:int, paid:int, expired:int, credited:int, credited_total:string, review:int, errors:int, failed_refs:list<string>, em_closed:bool}
     */
    public function sweep(?DateTimeImmutable $now = null, array $skip = [], int $limit = 50): array
    {
        $now    ??= new DateTimeImmutable();
        $result = ['reverified' => 0, 'paid' => 0, 'expired' => 0, 'credited' => 0, 'credited_total' => '0.00', 'review' => 0, 'errors' => 0, 'failed_refs' => [], 'em_closed' => false];
        $due    = $now->modify('-' . self::REVERIFY_AFTER_MINUTES . ' minutes');
        $slow   = $now->modify('-' . self::REVERIFY_SLOW_AFTER_HOURS . ' hours');
        $stale  = $now->modify('-' . self::EXPIRE_AFTER_HOURS . ' hours');

        // Every 15 minutes for a checkout's first two hours, then every two hours until it expires.
        foreach ($this->intents->dueForReverify($due, $slow, $due, $slow, $limit, $skip) as $intent) {
            $reference = $intent->getReference();
            $created   = $intent->getCreatedAt();
            try {
                $result['reverified']++;
                $after = $this->confirmWithGateway($intent, $now);
                if ($after->isUnusedPaid()) {
                    $result['paid']++;
                } elseif ($after->getStatus() === PaymentIntent::STATUS_INITIATED) {
                    if ($created <= $stale && $this->intents->expire($reference, $stale, $now)) {
                        $result['expired']++;
                    } else {
                        $this->intents->touchChecked($reference, $now);
                    }
                }
            } catch (\Throwable $e) {
                $result['errors']++;
                $result['failed_refs'][] = $reference;
                error_log('[payments.sweep] re-verify ' . $reference . ' failed: ' . $e->getMessage());
                // To the back of the queue whatever went wrong; past a day unconfirmed it expires
                // (a late success still counts — the webhook or the patient's own request records it).
                $this->afterFailure($reference, $now);
                if (!$this->intents->isOpen()) {
                    $result['em_closed'] = true;

                    return $result;
                }
                if ($created <= $stale && $this->safely(fn (): bool => $this->intents->expire($reference, $stale, $now))) {
                    $result['expired']++;
                }
            }
        }

        $cutoff = $now->modify('-' . $this->creditAfterMinutes . ' minutes');
        foreach ($this->intents->dueForCredit($cutoff, $limit, $skip) as $intent) {
            $reference = $intent->getReference();
            try {
                $settled = $this->settle($reference);
                if ($settled['credited'] !== null) {
                    $result['credited']++;
                    $result['credited_total'] = bcadd($result['credited_total'], $settled['credited'], 2);
                } elseif ($settled['review']) {
                    $result['review']++;
                } else {
                    $this->afterFailure($reference, $now); // nothing credited (e.g. Paystack unreachable): to the back
                }
            } catch (\Throwable $e) {
                $result['errors']++;
                $result['failed_refs'][] = $reference;
                error_log('[payments.sweep] credit ' . $reference . ' failed: ' . $e->getMessage());
                $this->afterFailure($reference, $now);
                if (!$this->intents->isOpen()) {
                    $result['em_closed'] = true;

                    return $result;
                }
            }
        }

        return $result;
    }

    /** Move a payment the sweep just failed on to the back of its queue (best effort — on the bare connection). */
    private function afterFailure(string $reference, DateTimeImmutable $now): void
    {
        $this->safely(function () use ($reference, $now): bool {
            $this->intents->touchChecked($reference, $now);

            return true;
        });
    }

    /** @param callable(): bool $work */
    private function safely(callable $work): bool
    {
        try {
            return $work();
        } catch (\Throwable $e) {
            error_log('[payments.sweep] bookkeeping failed: ' . $e->getMessage());

            return false;
        }
    }

    /**
     * {@see sweep()} until it ends with the entity manager still open, at most
     * `$retries` times more: `$attempt($skip, $try)` runs one sweep skipping
     * the references that failed so far (attempt 0 on the current entity
     * manager, later ones on a fresh one). The attempts' counts are added up.
     *
     * @param callable(list<string>, int): array<string,mixed> $attempt
     * @return array<string,mixed> sweep()'s result, plus `retries`
     */
    public static function sweepWithRetries(callable $attempt, int $retries = 2): array
    {
        $total = null;
        $skip  = [];
        for ($try = 0; ; ++$try) {
            $result = $attempt($skip, $try);
            $skip   = array_values(array_unique([...$skip, ...$result['failed_refs']]));
            if ($total === null) {
                $total = $result + ['review' => 0];
            } else {
                foreach (['reverified', 'paid', 'expired', 'credited', 'review', 'errors'] as $key) {
                    $total[$key] = ($total[$key] ?? 0) + ($result[$key] ?? 0);
                }
                $total['credited_total'] = bcadd($total['credited_total'], $result['credited_total'], 2);
                $total['em_closed']      = $result['em_closed'];
            }
            if (!$result['em_closed'] || $try >= $retries) {
                break;
            }
        }
        $total['failed_refs'] = $skip;
        $total['retries']     = $try;

        return $total;
    }

    // ----- Helpers -----

    /** " If it isn't used, it will be added to your VideoMed wallet automatically within about 30 minutes." — only for a paid, unused payment. */
    private function autoCreditNote(PaymentIntent $intent): string
    {
        return $intent->isUnusedPaid()
            ? sprintf(" If it isn't used, it will be added to your VideoMed wallet automatically within about %d minutes.", $this->creditAfterMinutes)
            : '';
    }

    /**
     * A reference that isn't a card checkout but is in the wallet ledger (a
     * wallet top-up's): "already in your wallet" only when that top-up's money
     * really is in the wallet — credited, or a pre-fix row the old race left
     * `failed` after crediting it ({@see WalletTransaction::isPostedButNotSuccess()})
     * — and only the patient's own; anything else is refused without saying it
     * is in the wallet.
     *
     * @throws ValidationException when `$reference` is a ledger reference
     */
    private function refuseLedgerReference(string $reference, string $ownerId): void
    {
        $entry = $reference !== '' ? $this->ledger->byReferenceFresh($reference) : null;
        if ($entry === null) {
            return;
        }
        if (!$entry->isTopup() || $entry->getPatientId() !== $ownerId) {
            throw self::refusal(self::NOT_FOUND);
        }
        if ($entry->isSuccess() || $entry->isPostedButNotSuccess()) {
            throw self::inWallet();
        }
        throw self::refusal($entry->isPending() ? self::TOPUP_PENDING : self::TOPUP_NOT_CREDITED);
    }

    private static function refuseSettled(string $status): void
    {
        if ($status === PaymentIntent::STATUS_CONSUMED) {
            throw self::refusal(self::ALREADY_USED);
        }
        if ($status === PaymentIntent::STATUS_CREDITED) {
            throw self::inWallet();
        }
        if ($status === PaymentIntent::STATUS_REVIEW) {
            throw self::refusal(self::UNDER_REVIEW);
        }
    }

    private static function refusal(string $message): ValidationException
    {
        return new ValidationException(['payment' => $message], $message);
    }

    /** Flagged so the app switches to paying from the wallet. */
    private static function inWallet(): ValidationException
    {
        return new ValidationException(['payment' => self::ALREADY_IN_WALLET, 'card_payment' => 'credited_to_wallet'], self::ALREADY_IN_WALLET);
    }

    private function appointmentOf(PaymentIntent $intent, PaymentUse $use): ?string
    {
        return $intent->contextValue('appointment_id')
            ?? ($intent->getPurpose() === PaymentIntent::PURPOSE_GUEST ? null : $use->usedBy);
    }

    private static function creditDescription(PaymentIntent $intent): string
    {
        return match ($intent->getPurpose()) {
            PaymentIntent::PURPOSE_GUEST     => 'Unused card payment (guest invitation) — added to your wallet',
            PaymentIntent::PURPOSE_FOLLOW_UP => 'Unused card payment (follow-up consultation) — added to your wallet',
            default                          => 'Unused card payment (consultation booking) — added to your wallet',
        };
    }

    private function notifyCredited(PaymentIntent $intent, string $amount): void
    {
        $this->notify(
            $intent->getPatientId(),
            'Card payment added to your wallet',
            sprintf(
                "Your card payment of %s (reference %s) wasn't used, so we added it to your VideoMed wallet. You can use it for your next consultation.",
                $this->money($amount, (string) ($intent->getVerifiedCurrency() ?? $intent->getCurrency())),
                $intent->getReference(),
            ),
        );
    }

    private function notify(string $patientId, string $title, string $body): void
    {
        try {
            $patient = $this->patients->find($patientId);
            if ($patient instanceof Patient) {
                $this->notifier->notify($patient, NotificationType::PAYMENT, $title, $body, '/dashboard/wallet');
            }
        } catch (\Throwable) {
            // The money already moved; a missing notice isn't fatal.
        }
    }

    /** "₦5,000.00" — display only. */
    private function money(string $amount, string $currency): string
    {
        [$whole, $fraction] = array_pad(explode('.', bcadd($amount, '0', 2)), 2, '00');

        return (strtoupper($currency) === 'NGN' ? '₦' : strtoupper($currency) . ' ') . number_format((int) $whole) . '.' . $fraction;
    }

    /** Minor units (kobo) → a major-unit decimal string. */
    public static function fromMinor(int $minor): string
    {
        return bcdiv((string) $minor, '100', 2);
    }
}
