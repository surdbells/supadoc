<?php

declare(strict_types=1);

namespace App\Infrastructure\Service;

use App\Domain\Entity\AuditEvent;
use App\Domain\Entity\Notification;
use App\Domain\Entity\Wallet;
use App\Domain\Entity\WalletTransaction;
use App\Domain\Enum\NotificationType;
use App\Domain\Exception\InsufficientFundsException;
use App\Domain\Exception\LedgerReferenceConflictException;
use App\Domain\Repository\NotificationRepository;
use App\Domain\Repository\PatientRepository;
use App\Domain\Repository\WalletRepository;
use App\Domain\Repository\WalletTransactionRepository;
use App\Infrastructure\Email\WalletMailer;
use Doctrine\DBAL\LockMode;
use Doctrine\ORM\EntityManagerInterface;

/**
 * The wallet book of record. Every balance change goes through here so that the
 * cached {@see Wallet} balance and the append-only {@see WalletTransaction} ledger
 * stay consistent. Money is bcmath decimal-string, scale 2 — never a float.
 *
 * Concurrency rules (a webhook, the browser's verify and a retry can all arrive
 * at once, each in its own request with its own, possibly stale, in-memory
 * copies):
 *  - every posting runs in ONE DB transaction that locks the wallet row
 *    (PESSIMISTIC_WRITE, which also re-reads it), and only then looks at the
 *    ledger — so postings to a wallet are serialised and each sees what the
 *    previous one committed;
 *  - an existing ledger entry is never trusted from memory: it is re-read
 *    under a row lock, and its status change is a compare-and-set UPDATE whose
 *    affected-row count decides the single winner;
 *  - lock order is always wallet row, then ledger row (no deadlocks between
 *    these paths);
 *  - the audit event is written in the same transaction as the money; receipts
 *    and notices go out after commit, and only from the call that moved money.
 */
final class WalletService
{
    private const SCALE = 2;

    /** Minor units per major unit for every supported currency (kobo, cents, pesewas). */
    private const MINOR_PER_MAJOR = '100';

    /** Largest amount accepted from input (well inside DECIMAL(18,2)). */
    private const MAX_AMOUNT = '1000000000000.00';

    /** Compare-and-set guard: the row never moved money (see WalletTransaction::wasPosted()). */
    private const CAS_UNPOSTED = 'posted_at IS NULL AND balance_after IS NULL';

    /** Compare-and-set guard: the row carries a complete posting. */
    private const CAS_POSTED = 'posted_at IS NOT NULL AND balance_after IS NOT NULL';

    /** Gateway figures kept with a settled/held top-up (minor units, digits only). */
    private const GATEWAY_DETAIL_KEYS = ['gross_amount_minor', 'fees_minor', 'requested_amount_minor'];

    /** @var list<string> */
    private readonly array $currencies;

    /**
     * @param list<string> $currencies supported currency codes; first is the default
     */
    public function __construct(
        private readonly EntityManagerInterface $em,
        private readonly WalletRepository $wallets,
        private readonly WalletTransactionRepository $txns,
        private readonly WalletMailer $mailer,
        private readonly NotificationRepository $notifications,
        private readonly PatientRepository $patients,
        array $currencies = ['NGN'],
    ) {
        $this->currencies = $currencies !== [] ? array_values(array_map('strtoupper', $currencies)) : ['NGN'];
    }

    /** @return list<string> */
    public function supportedCurrencies(): array
    {
        return $this->currencies;
    }

    public function defaultCurrency(): string
    {
        return $this->currencies[0];
    }

    public function isSupported(string $currency): bool
    {
        return in_array(strtoupper($currency), $this->currencies, true);
    }

    /** Get (or lazily create) a patient's wallet for a currency. */
    public function walletFor(string $patientId, string $currency): Wallet
    {
        $currency = strtoupper($currency);
        $wallet   = $this->wallets->findFor($patientId, $currency);
        if ($wallet === null) {
            $wallet = new Wallet($patientId, $currency);
            $this->wallets->save($wallet);
        }

        return $wallet;
    }

    /**
     * Create a pending top-up ledger entry before redirecting to the gateway. The
     * balance is unaffected until the entry is settled (verify/webhook).
     */
    public function beginTopup(string $patientId, string $currency, string $amount, string $reference): WalletTransaction
    {
        $wallet = $this->walletFor($patientId, $currency);
        $txn    = new WalletTransaction(
            $wallet->getId(),
            $patientId,
            WalletTransaction::TYPE_TOPUP,
            WalletTransaction::DIR_CREDIT,
            $this->normalise($amount),
            $wallet->getCurrency(),
            $reference,
            WalletTransaction::STATUS_PENDING,
        );
        $txn->setProvider('paystack');
        $txn->setDescription('Wallet funded via paystack');
        $this->txns->save($txn);

        return $txn;
    }

    /**
     * Credit a VERIFIED top-up to its wallet — at most once, ever.
     *
     * Call only after the gateway's verify said the charge succeeded, passing
     * what it verified: the amount in minor units (kobo; digits only) and the
     * currency. In one DB transaction this locks the wallet row and then the
     * ledger row, re-reads the entry from the database (never this request's
     * possibly stale copy) and moves it pending|failed → success with a
     * compare-and-set UPDATE that also requires the row never posted; only
     * that winner credits the balance and audits. Receipt + in-app notice
     * follow the commit, from the winner only.
     *
     * The verified amount and currency must EQUAL what the top-up asked for.
     * Otherwise nothing is credited: the entry is held as `review` for support
     * (audited, logged, and the patient is told), and stays held — settleTopup
     * never credits it afterwards.
     *
     * An entry that already moved money but isn't marked `success` (a pre-fix
     * row the old late-failure race left `failed` after crediting it) is never
     * credited again: nothing changes, the refusal is audited + logged, and
     * support restores it ({@see restorePostedTopup()}).
     *
     * @param string               $verifiedAmountMinor what the gateway verified as paid TO US, in minor
     *                                                  units ("500000" = ₦5,000.00) — fees a customer paid on
     *                                                  top are not part of it ({@see PaystackService::verify()})
     * @param string|null          $providerReference   the gateway's own transaction id, kept on the entry
     * @param array<string,mixed>  $gatewayDetails      optional gateway figures kept in the entry's metadata
     *                                                  (gross_amount_minor, fees_minor, requested_amount_minor)
     * @return WalletTransaction|null the entry THIS call credited; null when it
     *         credited nothing: already credited (earlier or concurrently), held
     *         for review (now or before), resolved by support, or a pre-fix
     *         posted row (refused)
     * @throws \RuntimeException         unknown reference, or not a top-up
     * @throws \InvalidArgumentException a malformed verified amount (nothing changed)
     */
    public function settleTopup(
        string $reference,
        string $verifiedAmountMinor,
        string $verifiedCurrency,
        ?string $providerReference = null,
        array $gatewayDetails = [],
    ): ?WalletTransaction {
        $verifiedAmountMinor = self::parseMinor($verifiedAmountMinor);
        $verifiedCurrency    = strtoupper(trim($verifiedCurrency));
        $gatewayDetails      = self::gatewayDetails($gatewayDetails);
        $entry               = $this->topupEntry($reference);

        $outcome = null; // 'posted' | 'held' | 'refused_posted' — set only by the call that decided
        $result  = $this->em->wrapInTransaction(function () use ($entry, $verifiedAmountMinor, $verifiedCurrency, $providerReference, $gatewayDetails, &$outcome): ?WalletTransaction {
            $wallet = $this->lock($entry->getWalletId());
            $txn    = $this->lockEntry($entry->getId());
            if ($txn->isPostedButNotSuccess()) {
                // Credited before, then marked failed by the pre-fix race: its money is
                // already in the wallet. Crediting it again would double it.
                $this->audit('wallet.topup_settle_refused_already_posted', $txn, [
                    'status'                => $txn->getStatus(),
                    'balance_after'         => $txn->getBalanceAfter(),
                    'posted_at'             => $txn->getPostedAt()?->format(DATE_ATOM),
                    'verified_amount_minor' => $verifiedAmountMinor,
                    'verified_currency'     => $verifiedCurrency,
                    'provider_reference'    => $providerReference,
                ]);
                $outcome = 'refused_posted';

                return null;
            }
            if (!$txn->isSettleable()) {
                return null; // already credited / held / resolved — decided by an earlier call
            }

            $mismatch = self::topupMismatch($txn, $verifiedAmountMinor, $verifiedCurrency);
            if ($mismatch !== null) {
                if (!$this->compareAndSet($txn, WalletTransaction::STATUS_REVIEW, WalletTransaction::SETTLEABLE, self::CAS_UNPOSTED)) {
                    return null;
                }
                $txn->holdForReview($mismatch + $gatewayDetails + ['held_at' => gmdate(DATE_ATOM)], $providerReference);
                $this->audit('wallet.topup_held_for_review', $txn, $mismatch + $gatewayDetails + ['provider_reference' => $providerReference]);
                $outcome = 'held';

                return null;
            }

            if (!$this->compareAndSet($txn, WalletTransaction::STATUS_SUCCESS, WalletTransaction::SETTLEABLE, self::CAS_UNPOSTED)) {
                return null; // someone else won the compare-and-set
            }
            $balance = bcadd($wallet->getBalance(), $txn->getAmount(), self::SCALE);
            $wallet->setBalance($balance);
            $txn->markPosted($balance, 'paystack', $providerReference);
            $txn->mergeMetadata([
                'verified_amount_minor' => $verifiedAmountMinor,
                'verified_currency'     => $verifiedCurrency,
            ] + ($gatewayDetails !== [] ? ['gateway' => $gatewayDetails] : []));
            $this->audit('wallet.topup_credited', $txn, [
                'amount'                => $txn->getAmount(),
                'currency'              => $txn->getCurrency(),
                'balance_after'         => $balance,
                'verified_amount_minor' => $verifiedAmountMinor,
                'provider_reference'    => $providerReference,
            ] + $gatewayDetails);
            $outcome = 'posted';

            return $txn;
        });

        if ($outcome === 'posted' && $result !== null) {
            $this->mailer->sendReceipt($result);
            $this->notifyToppedUp($result);
        } elseif ($outcome === 'refused_posted') {
            error_log(sprintf(
                '[wallet.topup] NOT credited again: ref=%s already moved money (old race left it %s) — support: restorePostedTopup(), see bin/wallet-reconcile.php',
                $entry->getReference(),
                $entry->getStatus(),
            ));
        } elseif ($outcome === 'held') {
            error_log(sprintf(
                '[wallet.topup] HELD for review, nothing credited: ref=%s expected=%s %s verified=%s minor %s — see bin/wallet-reconcile.php',
                $entry->getReference(),
                $entry->getAmount(),
                $entry->getCurrency(),
                $verifiedAmountMinor,
                $verifiedCurrency !== '' ? $verifiedCurrency : '(none)',
            ));
            $this->notifyHeld($entry);
        }

        return $result;
    }

    /**
     * Why a verified payment can't settle this top-up, or null when it can: the
     * verified amount (minor units) and currency must equal exactly what the
     * top-up asked for — a smaller payment is not "partly" credited and a larger
     * one is not silently absorbed.
     *
     * @return array{reason:string, expected_amount_minor:string, expected_currency:string, verified_amount_minor:string, verified_currency:string}|null
     */
    public static function topupMismatch(WalletTransaction $txn, string $verifiedAmountMinor, string $verifiedCurrency): ?array
    {
        $verified         = self::parseMinor($verifiedAmountMinor);
        $verifiedCurrency = strtoupper(trim($verifiedCurrency));
        $expected         = self::minorUnits($txn->getAmount());

        $amountOk   = bccomp($verified, $expected, 0) === 0;
        $currencyOk = $verifiedCurrency === $txn->getCurrency();
        if ($amountOk && $currencyOk) {
            return null;
        }

        return [
            'reason'                => !$currencyOk ? ($amountOk ? 'currency_mismatch' : 'amount_and_currency_mismatch') : 'amount_mismatch',
            'expected_amount_minor' => $expected,
            'expected_currency'     => $txn->getCurrency(),
            'verified_amount_minor' => $verified,
            'verified_currency'     => $verifiedCurrency,
        ];
    }

    /** A decimal amount ("5000.00") in minor units ("500000"), as a digit string. */
    public static function minorUnits(string $amount): string
    {
        return bcmul($amount, self::MINOR_PER_MAJOR, 0);
    }

    /**
     * A gateway amount in minor units, validated: digits only (no sign, no
     * decimals, no exponent), leading zeros dropped.
     *
     * @throws \InvalidArgumentException
     */
    public static function parseMinor(string $amountMinor): string
    {
        $amountMinor = trim($amountMinor);
        if (preg_match('/^\d{1,18}$/', $amountMinor) !== 1) {
            throw new \InvalidArgumentException('Malformed verified amount');
        }
        $digits = ltrim($amountMinor, '0');

        return $digits === '' ? '0' : $digits;
    }

    /**
     * What a gateway verify status means for a top-up: `paid` (settle it),
     * `not_paid` (the charge did not complete) or `processing` (not final yet —
     * anything not recognised is treated as not final, never as paid).
     */
    public static function gatewayOutcome(string $gatewayStatus): string
    {
        $status = strtolower(trim($gatewayStatus));
        if ($status === 'success') {
            return 'paid';
        }

        return in_array($status, ['failed', 'abandoned', 'reversed'], true) ? 'not_paid' : 'processing';
    }

    /**
     * The known gateway figures from `$details`, as digit strings (anything
     * else dropped) — informational only; they never decide a credit.
     *
     * @param array<string,mixed> $details
     * @return array<string,string>
     */
    private static function gatewayDetails(array $details): array
    {
        $out = [];
        foreach (self::GATEWAY_DETAIL_KEYS as $key) {
            $value = $details[$key] ?? null;
            if ((is_int($value) && $value >= 0) || (is_string($value) && preg_match('/^\d{1,18}$/', $value) === 1)) {
                $out[$key] = (string) $value;
            }
        }

        return $out;
    }

    /** Best-effort in-app payment notification when a top-up credits the wallet. */
    private function notifyToppedUp(WalletTransaction $txn): void
    {
        $currency = $txn->getCurrency() === 'NGN' ? '₦' : $txn->getCurrency() . ' ';
        $this->notify($txn, 'Wallet funded', sprintf('Your wallet was credited with %s%s.', $currency, $txn->getAmount()));
    }

    /** Best-effort, honest in-app notice that a payment was received but NOT credited. */
    private function notifyHeld(WalletTransaction $txn): void
    {
        $this->notify($txn, 'Top-up under review', sprintf(
            "We received a payment for your top-up (reference %s), but it didn't match the amount you chose, so it hasn't been added to your wallet yet. It has been flagged for our support team to review — contact support and quote this reference if you have questions.",
            $txn->getReference(),
        ));
    }

    private function notify(WalletTransaction $txn, string $title, string $body): void
    {
        try {
            $patient = $this->patients->find($txn->getPatientId());
            if ($patient === null) {
                return;
            }
            $this->notifications->save(new Notification($patient, NotificationType::PAYMENT, $title, $body));
        } catch (\Throwable) {
            // The ledger is already right; a missing notification isn't fatal.
        }
    }

    /**
     * Mark a pending top-up failed (the gateway said the charge failed). Locked
     * re-read: a top-up another request credited (or held) meanwhile is never
     * downgraded — nor is one that already moved money. Returns whether this
     * call marked it.
     */
    public function failTopup(string $reference): bool
    {
        $entry = $this->txns->byReference($reference);
        if ($entry === null || !$entry->isTopup()) {
            return false;
        }

        return $this->em->wrapInTransaction(function () use ($entry): bool {
            $txn = $this->lockEntry($entry->getId());
            if (!$txn->isPending() || $txn->wasPosted()) {
                return false;
            }
            $txn->markFailed();
            $this->audit('wallet.topup_failed', $txn, ['amount' => $txn->getAmount(), 'currency' => $txn->getCurrency()]);

            return true;
        });
    }

    /**
     * Support's way out of a top-up held for review, after checking the payment
     * in the gateway dashboard:
     *  - `$creditAmount` = what was actually received, to add it to the wallet
     *    (posted as a separate `adjustment` credit, reference "resolve_<entry id>"), or
     *  - null when the payment was refunded on the gateway instead (nothing credited).
     * Either way the held entry becomes `resolved` (final). One transaction, same
     * locks and compare-and-set as settleTopup; idempotent — an entry that is no
     * longer held returns null and changes nothing.
     *
     * @return WalletTransaction|null the adjustment credit when one was posted, else
     *         the resolved entry; null when the entry was not held
     */
    public function resolveHeldTopup(string $reference, ?string $creditAmount, string $note, string $actorName): ?WalletTransaction
    {
        $note = trim($note);
        if ($note === '') {
            throw new \InvalidArgumentException('Say how the payment was resolved');
        }
        $creditAmount = $creditAmount !== null ? $this->normalise($creditAmount) : null;
        $entry        = $this->topupEntry($reference);

        $credit = null;
        $result = $this->em->wrapInTransaction(function () use ($entry, $creditAmount, $note, $actorName, &$credit): ?WalletTransaction {
            $wallet = $this->lock($entry->getWalletId());
            $txn    = $this->lockEntry($entry->getId());
            if (!$txn->needsReview() || !$this->compareAndSet($txn, WalletTransaction::STATUS_RESOLVED, [WalletTransaction::STATUS_REVIEW], self::CAS_UNPOSTED)) {
                return null;
            }
            $txn->markResolved([
                'note'          => mb_substr($note, 0, 255),
                'by'            => $actorName,
                'credit_amount' => $creditAmount,
                'at'            => gmdate(DATE_ATOM),
            ]);
            $this->audit('wallet.topup_review_resolved', $txn, ['note' => mb_substr($note, 0, 255), 'credit_amount' => $creditAmount], $actorName, 'staff');

            if ($creditAmount !== null) {
                $credit = $this->post(
                    $wallet,
                    $txn->getPatientId(),
                    $creditAmount,
                    WalletTransaction::DIR_CREDIT,
                    WalletTransaction::TYPE_ADJUSTMENT,
                    'resolve_' . $txn->getId(),
                    mb_substr('Top-up ' . $txn->getReference() . ' resolved by support', 0, 255),
                    ['resolves' => $txn->getReference()],
                    $actorName,
                    'staff',
                );
            }

            return $credit ?? $txn;
        });

        if ($credit !== null) {
            $this->mailer->sendReceipt($credit);
        }

        return $result;
    }

    /**
     * Support's correction for a top-up the pre-fix late-failure race left
     * `failed` (or pending) AFTER crediting it — the reconciler's
     * `posted_entry_not_success`. Its money is already in the wallet; only the
     * ledger doesn't count it. This moves the entry back to `success` WITHOUT
     * changing the balance, so the ledger accounts for it again. (Never
     * credit() it, never settle it again, and don't claw it back as a
     * "duplicate": the patient paid for it once and holds it once.)
     *
     * One transaction under the wallet + entry locks, compare-and-set,
     * audited. It first checks the wallet really holds the money beyond what
     * its ledger counts (balance − ledger ≥ amount); otherwise (e.g. it was
     * already recorded and recovered by hand) it refuses and changes nothing.
     * Idempotent: an entry not (or no longer) in that state returns null.
     *
     * @throws \InvalidArgumentException no note
     * @throws \RuntimeException         unknown top-up, or the wallet doesn't hold the money (nothing changed)
     */
    public function restorePostedTopup(string $reference, string $note, string $actorName): ?WalletTransaction
    {
        $note = trim($note);
        if ($note === '') {
            throw new \InvalidArgumentException('Say why the entry is being restored');
        }
        $entry = $this->topupEntry($reference);

        $refusal = null;
        $result  = $this->em->wrapInTransaction(function () use ($entry, $note, $actorName, &$refusal): ?WalletTransaction {
            $wallet = $this->lock($entry->getWalletId());
            $txn    = $this->lockEntry($entry->getId());
            if (!$txn->isPostedButNotSuccess() || !in_array($txn->getStatus(), WalletTransaction::SETTLEABLE, true)) {
                return null;
            }
            if ($txn->getPostedAt() === null || $txn->getBalanceAfter() === null) {
                $refusal = sprintf(
                    'Not restored: %s records only part of a posting (posted_at %s, balance_after %s) — nothing was changed; escalate to engineering.',
                    $txn->getReference(),
                    $txn->getPostedAt()?->format(DATE_ATOM) ?? 'missing',
                    $txn->getBalanceAfter() ?? 'missing',
                );

                return null;
            }
            $ledger  = $this->ledgerSum($wallet->getId());
            $surplus = bcsub($wallet->getBalance(), $ledger, self::SCALE);
            if (bccomp($surplus, $txn->getAmount(), self::SCALE) < 0) {
                $refusal = sprintf(
                    'Not restored: wallet %s holds only %s beyond its ledger (balance %s, ledger %s), less than this top-up\'s %s — restoring it would count money the wallet does not hold. Nothing was changed; escalate to engineering.',
                    $wallet->getId(),
                    $surplus,
                    $wallet->getBalance(),
                    $ledger,
                    $txn->getAmount(),
                );

                return null;
            }
            if (!$this->compareAndSet($txn, WalletTransaction::STATUS_SUCCESS, WalletTransaction::SETTLEABLE, self::CAS_POSTED)) {
                return null;
            }
            $from = $txn->getStatus();
            $txn->restorePosted([
                'from'          => $from,
                'note'          => mb_substr($note, 0, 255),
                'by'            => $actorName,
                'balance'       => $wallet->getBalance(),
                'ledger_before' => $ledger,
                'at'            => gmdate(DATE_ATOM),
            ]);
            $this->audit('wallet.topup_posted_status_restored', $txn, [
                'from'          => $from,
                'amount'        => $txn->getAmount(),
                'balance'       => $wallet->getBalance(),
                'ledger_before' => $ledger,
                'balance_moved' => false,
                'note'          => mb_substr($note, 0, 255),
            ], $actorName, 'staff');

            return $txn;
        });

        if ($refusal !== null) {
            throw new \RuntimeException($refusal);
        }

        return $result;
    }

    /**
     * Record, as an `adjustment` ledger entry, the difference between a wallet's
     * cached balance and its ledger (the signed sum of successful entries) — WITHOUT
     * changing the balance — so the ledger again accounts for every unit of it
     * (e.g. a top-up an old race credited twice). Computed under the wallet lock.
     * Whether to recover (debit) or make good (credit) the money is a separate,
     * deliberate {@see debit()} / {@see credit()}. Returns null when they agree.
     *
     * Refused (nothing changed) while the wallet has a top-up that moved money
     * but isn't marked success: part of the difference is then money the
     * patient paid once and holds once — restore those first
     * ({@see restorePostedTopup()}), or it would be "recovered" from them.
     *
     * @throws \RuntimeException when such an entry exists (nothing changed)
     */
    public function recordLedgerDiscrepancy(string $walletId, string $note, string $actorName): ?WalletTransaction
    {
        $note = trim($note);
        if ($note === '') {
            throw new \InvalidArgumentException('Say why the difference is being recorded');
        }

        $refusal = null;
        $result  = $this->em->wrapInTransaction(function () use ($walletId, $note, $actorName, &$refusal): ?WalletTransaction {
            $wallet     = $this->lock($walletId);
            $unrestored = $this->em->getConnection()->fetchFirstColumn(
                sprintf(
                    "SELECT reference FROM %s WHERE wallet_id = ? AND status <> ? AND (posted_at IS NOT NULL OR balance_after IS NOT NULL) ORDER BY created_at, reference",
                    $this->ledgerTable(),
                ),
                [$walletId, WalletTransaction::STATUS_SUCCESS],
            );
            if ($unrestored !== []) {
                $refusal = sprintf(
                    'Not recorded: wallet %s has entries that moved money but are not marked success (%s). Restore them first with restorePostedTopup() — they are money the patient paid, not a discrepancy. Nothing was changed.',
                    $walletId,
                    implode(', ', array_map('strval', $unrestored)),
                );

                return null;
            }
            $ledger     = $this->ledgerSum($walletId);
            $difference = bcsub($wallet->getBalance(), $ledger, self::SCALE);
            if (bccomp($difference, '0', self::SCALE) === 0) {
                return null;
            }

            $positive = bccomp($difference, '0', self::SCALE) > 0;
            $txn      = new WalletTransaction(
                $wallet->getId(),
                $wallet->getPatientId(),
                WalletTransaction::TYPE_ADJUSTMENT,
                $positive ? WalletTransaction::DIR_CREDIT : WalletTransaction::DIR_DEBIT,
                $positive ? $difference : bcmul($difference, '-1', self::SCALE),
                $wallet->getCurrency(),
                'recon_' . bin2hex(random_bytes(12)),
            );
            $txn->setProvider('system');
            $txn->setDescription(mb_substr('Reconciliation: ' . $note, 0, 255));
            $txn->setMetadata([
                'reconciliation' => [
                    'balance'       => $wallet->getBalance(),
                    'ledger_before' => bcadd($ledger, '0', self::SCALE),
                    'note'          => mb_substr($note, 0, 255),
                    'by'            => $actorName,
                ],
            ]);
            $txn->markPosted($wallet->getBalance()); // the balance itself is unchanged
            $this->em->persist($txn);
            $this->audit('wallet.ledger_discrepancy_recorded', $txn, [
                'difference'    => $difference,
                'balance'       => $wallet->getBalance(),
                'ledger_before' => bcadd($ledger, '0', self::SCALE),
                'note'          => mb_substr($note, 0, 255),
            ], $actorName, 'staff');

            return $txn;
        });

        if ($refusal !== null) {
            throw new \RuntimeException($refusal);
        }

        return $result;
    }

    /** Whether the ledger holds an entry (of any status) under `$reference` — e.g. a top-up's Paystack reference. */
    public function hasPosting(string $reference): bool
    {
        return $this->txns->byReference($reference) !== null;
    }

    /**
     * Credit a wallet immediately (e.g. a consultation refund). Idempotent on
     * $reference: a retry with the same terms returns the posted entry; the
     * same reference with different terms (wallet, direction or amount) throws
     * {@see LedgerReferenceConflictException} and posts nothing — so key every
     * correction to what it corrects. Creates the wallet if the patient has
     * none for this currency. `$sendReceipt` false posts it without the receipt
     * email (a quiet backlog refund from the cron — the ledger entry is still
     * there). Never for top-ups: a Paystack payment is credited only through
     * {@see settleTopup()} (verified, once), so `topup` is refused here.
     *
     * @throws LedgerReferenceConflictException
     */
    public function credit(string $patientId, string $currency, string $amount, string $type, string $reference, ?string $description = null, bool $sendReceipt = true): WalletTransaction
    {
        return $this->apply($patientId, $currency, $amount, WalletTransaction::DIR_CREDIT, $type, $reference, $description, $sendReceipt);
    }

    /**
     * Debit a wallet immediately (e.g. paying for a consultation). Idempotent on
     * $reference (as {@see credit()}). Throws {@see InsufficientFundsException}
     * if the balance is short. `$sendReceipt` false posts it without the
     * receipt email: for a debit inside the caller's own transaction (a
     * booking), which sends it with {@see sendReceipt()} once that commits —
     * sent from here it would go out while the caller still holds its locks,
     * and even for a debit the caller then rolls back.
     *
     * @throws LedgerReferenceConflictException
     */
    public function debit(string $patientId, string $currency, string $amount, string $type, string $reference, ?string $description = null, bool $sendReceipt = true): WalletTransaction
    {
        return $this->apply($patientId, $currency, $amount, WalletTransaction::DIR_DEBIT, $type, $reference, $description, $sendReceipt);
    }

    /**
     * Email the receipt for `$txn`, a posting made with `$sendReceipt` false —
     * only after the transaction that posted it committed (best-effort, never
     * throws: {@see WalletMailer}).
     */
    public function sendReceipt(WalletTransaction $txn): void
    {
        $this->mailer->sendReceipt($txn);
    }

    private function apply(
        string $patientId,
        string $currency,
        string $amount,
        string $direction,
        string $type,
        string $reference,
        ?string $description,
        bool $sendReceipt = true,
    ): WalletTransaction {
        if ($type === WalletTransaction::TYPE_TOPUP) {
            throw new \InvalidArgumentException('A top-up is credited only by settleTopup() after the gateway verified it');
        }
        $amount = $this->normalise($amount);
        // Ensure the wallet exists (own tx) before locking it inside the posting tx.
        $walletId = $this->walletFor($patientId, $currency)->getId();

        $newlyPosted = false;
        $conflict    = null;
        $txn         = $this->em->wrapInTransaction(function () use (
            $patientId,
            $walletId,
            $amount,
            $direction,
            $type,
            $reference,
            $description,
            &$newlyPosted,
            &$conflict,
        ): WalletTransaction {
            // Lock the wallet FIRST: every posting to it queues here, so the
            // reference check below sees whatever a concurrent posting with the
            // same reference committed — it returns that entry instead of
            // posting twice (or failing on the unique index).
            $wallet   = $this->lock($walletId);
            $existing = $this->txns->byReferenceFresh($reference);
            if ($existing !== null) {
                if (!$existing->isSuccess()) {
                    throw new \RuntimeException(sprintf('Ledger reference %s is already used by a %s entry', $reference, $existing->getStatus()));
                }
                if ($existing->getWalletId() !== $walletId || $existing->getDirection() !== $direction || bccomp($existing->getAmount(), $amount, self::SCALE) !== 0) {
                    // Not a retry of that posting: refuse loudly (after this empty
                    // transaction ends, so the EntityManager stays usable).
                    $conflict = sprintf(
                        'Ledger reference %s already holds a different posting (%s %s on wallet %s; asked %s %s on wallet %s) — nothing was posted; use a reference of its own',
                        $reference,
                        $existing->getDirection(),
                        $existing->getAmount(),
                        $existing->getWalletId(),
                        $direction,
                        $amount,
                        $walletId,
                    );
                }

                return $existing; // idempotent
            }

            $newlyPosted = true;

            return $this->post($wallet, $patientId, $amount, $direction, $type, $reference, $description, [], 'System', 'system');
        });

        if ($conflict !== null) {
            error_log('[wallet] ' . $conflict);

            throw new LedgerReferenceConflictException($conflict);
        }

        // Receipt sent once, after the posting commits (idempotent re-postings
        // return the existing success entry and send nothing) — unless asked not to.
        if ($newlyPosted && $sendReceipt) {
            $this->mailer->sendReceipt($txn);
        }

        return $txn;
    }

    /**
     * Post a new entry against a wallet already locked by the caller's
     * transaction: move the balance, persist the entry, audit it.
     *
     * @param array<string,mixed> $metadata
     */
    private function post(
        Wallet $wallet,
        string $patientId,
        string $amount,
        string $direction,
        string $type,
        string $reference,
        ?string $description,
        array $metadata,
        string $actorName,
        string $actorRole,
    ): WalletTransaction {
        if ($direction === WalletTransaction::DIR_DEBIT) {
            if (bccomp($wallet->getBalance(), $amount, self::SCALE) < 0) {
                throw new InsufficientFundsException('Insufficient wallet balance');
            }
            $balance = bcsub($wallet->getBalance(), $amount, self::SCALE);
        } else {
            $balance = bcadd($wallet->getBalance(), $amount, self::SCALE);
        }

        $txn = new WalletTransaction(
            $wallet->getId(),
            $patientId,
            $type,
            $direction,
            $amount,
            $wallet->getCurrency(),
            $reference,
            WalletTransaction::STATUS_PENDING,
        );
        $txn->setProvider('system');
        $txn->setDescription($description);
        if ($metadata !== []) {
            $txn->setMetadata($metadata);
        }
        $txn->markPosted($balance);
        $wallet->setBalance($balance);
        $this->em->persist($txn);
        $this->audit($direction === WalletTransaction::DIR_DEBIT ? 'wallet.debited' : 'wallet.credited', $txn, [
            'type'          => $type,
            'amount'        => $amount,
            'currency'      => $wallet->getCurrency(),
            'balance_after' => $balance,
        ], $actorName, $actorRole);

        return $txn;
    }

    /** The top-up entry under `$reference` (any status), or a RuntimeException. */
    private function topupEntry(string $reference): WalletTransaction
    {
        $entry = $this->txns->byReference($reference);
        if ($entry === null || !$entry->isTopup()) {
            throw new \RuntimeException('Unknown wallet top-up');
        }

        return $entry;
    }

    /** Lock + re-read the wallet row (an already loaded copy is refreshed). */
    private function lock(string $walletId): Wallet
    {
        $wallet = $this->em->find(Wallet::class, $walletId, LockMode::PESSIMISTIC_WRITE);
        if (!$wallet instanceof Wallet) {
            throw new \RuntimeException('Wallet not found');
        }

        return $wallet;
    }

    /** Lock + re-read a ledger row: SELECT … FOR UPDATE, overwriting any stale in-memory copy. */
    private function lockEntry(string $id): WalletTransaction
    {
        $txn = $this->em->find(WalletTransaction::class, $id, LockMode::PESSIMISTIC_WRITE);
        if (!$txn instanceof WalletTransaction) {
            throw new \RuntimeException('Wallet transaction not found');
        }

        return $txn;
    }

    /**
     * Move a ledger row's status `$from` → `$to` in the database, but only if it
     * is still in one of `$from` (and meets `$guard`, one of the CAS_* constants):
     * the affected-row count decides who won. (Under the row lock this always
     * agrees with the locked re-read; it is the guard that keeps holding if that
     * ever stops being true.)
     *
     * @param list<string> $from
     */
    private function compareAndSet(WalletTransaction $txn, string $to, array $from, string $guard): bool
    {
        if (!in_array($guard, [self::CAS_UNPOSTED, self::CAS_POSTED, ''], true)) {
            throw new \LogicException('Unknown compare-and-set guard');
        }
        $placeholders = implode(', ', array_fill(0, count($from), '?'));

        return $this->em->getConnection()->executeStatement(
            sprintf(
                'UPDATE %s SET status = ? WHERE id = ? AND status IN (%s)%s',
                $this->ledgerTable(),
                $placeholders,
                $guard !== '' ? ' AND ' . $guard : '',
            ),
            [$to, $txn->getId(), ...$from],
        ) === 1;
    }

    /** Signed sum of a wallet's successful ledger entries (scale 2). Call under the wallet lock. */
    private function ledgerSum(string $walletId): string
    {
        $sum = (string) $this->em->getConnection()->fetchOne(
            sprintf(
                "SELECT COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount WHEN direction = 'debit' THEN -amount ELSE 0 END), 0)
                   FROM %s WHERE wallet_id = ? AND status = ?",
                $this->ledgerTable(),
            ),
            [$walletId, WalletTransaction::STATUS_SUCCESS],
        );

        return bcadd($sum === '' ? '0' : $sum, '0', self::SCALE);
    }

    private function ledgerTable(): string
    {
        return $this->em->getClassMetadata(WalletTransaction::class)->getTableName();
    }

    /**
     * Audit a money event in the SAME transaction as the money (it commits or
     * rolls back with it).
     *
     * @param array<string,mixed> $metadata
     */
    private function audit(string $action, WalletTransaction $txn, array $metadata, string $actorName = 'System', string $actorRole = 'system'): void
    {
        $reference = $txn->getReference();
        $this->em->persist(new AuditEvent(
            $actorName,
            $actorRole,
            $action,
            null,
            'wallet_transaction',
            strlen($reference) <= 64 ? $reference : $txn->getId(),
            $metadata + [
                'reference'  => $reference,
                'wallet_id'  => $txn->getWalletId(),
                'patient_id' => $txn->getPatientId(),
            ],
        ));
    }

    /**
     * Validate + round to the ledger scale; rejects non-positive/garbage amounts
     * (plain decimals only — "1e3" or "abc" are a 422, never a bcmath error).
     */
    public function normalise(string $amount): string
    {
        $amount = trim($amount);
        if ($amount === '' || preg_match('/^[+-]?(\d+\.?\d*|\.\d+)$/', $amount) !== 1) {
            throw new \InvalidArgumentException('Invalid amount');
        }
        $rounded = bcadd($amount, '0', self::SCALE);
        if (bccomp($rounded, '0.00', self::SCALE) <= 0) {
            throw new \InvalidArgumentException('Amount must be greater than zero');
        }
        if (bccomp($rounded, self::MAX_AMOUNT, self::SCALE) >= 0) {
            throw new \InvalidArgumentException('Amount is too large');
        }

        return $rounded;
    }

    /** Amount in the currency's minor unit (kobo/cents) for the gateway. */
    public function toMinor(string $amount): int
    {
        return (int) self::minorUnits($this->normalise($amount));
    }
}
