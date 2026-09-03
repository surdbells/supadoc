<?php

declare(strict_types=1);

namespace App\Infrastructure\Service;

use App\Domain\Entity\Wallet;
use App\Domain\Entity\WalletTransaction;
use App\Domain\Exception\InsufficientFundsException;
use App\Domain\Repository\WalletRepository;
use App\Domain\Repository\WalletTransactionRepository;
use Doctrine\DBAL\LockMode;
use Doctrine\ORM\EntityManagerInterface;

/**
 * The wallet book of record. Every balance change goes through here so that the
 * cached {@see Wallet} balance and the append-only {@see WalletTransaction} ledger
 * stay consistent: each posting runs inside a DB transaction that holds a
 * PESSIMISTIC_WRITE lock on the wallet row (no lost updates under concurrency) and
 * is idempotent on the transaction `reference` (a webhook + a client verify can
 * both fire without double-crediting). Money is bcmath decimal-string, scale 2.
 */
final class WalletService
{
    private const SCALE = 2;

    /** @var list<string> */
    private readonly array $currencies;

    /**
     * @param list<string> $currencies supported currency codes; first is the default
     */
    public function __construct(
        private readonly EntityManagerInterface $em,
        private readonly WalletRepository $wallets,
        private readonly WalletTransactionRepository $txns,
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
        $txn->setDescription('Wallet funded via Paystack');
        $this->txns->save($txn);

        return $txn;
    }

    /**
     * Settle a pending top-up: apply it to the balance atomically. Idempotent — a
     * second call (webhook after verify, or vice-versa) returns the same entry
     * without crediting again.
     */
    public function settleTopup(string $reference, ?string $providerReference = null): WalletTransaction
    {
        return $this->em->wrapInTransaction(function () use ($reference, $providerReference): WalletTransaction {
            $txn = $this->txns->byReference($reference);
            if ($txn === null) {
                throw new \RuntimeException('Unknown wallet transaction');
            }
            if ($txn->isSuccess()) {
                return $txn; // already applied — idempotent
            }

            $wallet  = $this->lock($txn->getWalletId());
            $balance = bcadd($wallet->getBalance(), $txn->getAmount(), self::SCALE);
            $wallet->setBalance($balance);
            $txn->markPosted($balance, 'paystack', $providerReference);

            return $txn;
        });
    }

    /** Mark a pending top-up failed (verify returned failed/abandoned). */
    public function failTopup(string $reference): void
    {
        $txn = $this->txns->byReference($reference);
        if ($txn !== null && $txn->isPending()) {
            $txn->markFailed();
            $this->txns->save($txn);
        }
    }

    /**
     * Credit a wallet immediately (e.g. a consultation refund). Idempotent on
     * $reference. Creates the wallet if the patient has none for this currency.
     */
    public function credit(string $patientId, string $currency, string $amount, string $type, string $reference, ?string $description = null): WalletTransaction
    {
        return $this->apply($patientId, $currency, $amount, WalletTransaction::DIR_CREDIT, $type, $reference, $description);
    }

    /**
     * Debit a wallet immediately (e.g. paying for a consultation). Idempotent on
     * $reference. Throws {@see InsufficientFundsException} if the balance is short.
     */
    public function debit(string $patientId, string $currency, string $amount, string $type, string $reference, ?string $description = null): WalletTransaction
    {
        return $this->apply($patientId, $currency, $amount, WalletTransaction::DIR_DEBIT, $type, $reference, $description);
    }

    private function apply(
        string $patientId,
        string $currency,
        string $amount,
        string $direction,
        string $type,
        string $reference,
        ?string $description,
    ): WalletTransaction {
        $amount = $this->normalise($amount);
        // Ensure the wallet exists (own tx) before locking it inside the posting tx.
        $walletId = $this->walletFor($patientId, $currency)->getId();

        return $this->em->wrapInTransaction(function () use (
            $patientId,
            $walletId,
            $amount,
            $direction,
            $type,
            $reference,
            $description,
        ): WalletTransaction {
            $existing = $this->txns->byReference($reference);
            if ($existing !== null && $existing->isSuccess()) {
                return $existing; // idempotent
            }

            $wallet = $this->lock($walletId);
            if ($direction === WalletTransaction::DIR_DEBIT) {
                if (bccomp($wallet->getBalance(), $amount, self::SCALE) < 0) {
                    throw new InsufficientFundsException('Insufficient wallet balance');
                }
                $balance = bcsub($wallet->getBalance(), $amount, self::SCALE);
            } else {
                $balance = bcadd($wallet->getBalance(), $amount, self::SCALE);
            }

            $txn = new WalletTransaction(
                $walletId,
                $patientId,
                $type,
                $direction,
                $amount,
                $wallet->getCurrency(),
                $reference,
                WalletTransaction::STATUS_SUCCESS,
            );
            $txn->setProvider('system');
            $txn->setDescription($description);
            $txn->markPosted($balance);
            $wallet->setBalance($balance);
            $this->em->persist($txn);

            return $txn;
        });
    }

    private function lock(string $walletId): Wallet
    {
        $wallet = $this->em->find(Wallet::class, $walletId, LockMode::PESSIMISTIC_WRITE);
        if (!$wallet instanceof Wallet) {
            throw new \RuntimeException('Wallet not found');
        }

        return $wallet;
    }

    /** Validate + round to the ledger scale; rejects non-positive/garbage amounts. */
    public function normalise(string $amount): string
    {
        $amount = trim($amount);
        if ($amount === '' || !is_numeric($amount)) {
            throw new \InvalidArgumentException('Invalid amount');
        }
        $rounded = bcadd($amount, '0', self::SCALE);
        if (bccomp($rounded, '0.00', self::SCALE) <= 0) {
            throw new \InvalidArgumentException('Amount must be greater than zero');
        }

        return $rounded;
    }

    /** Amount in the currency's minor unit (kobo/cents) for the gateway. */
    public function toMinor(string $amount): int
    {
        return (int) bcmul($this->normalise($amount), '100', 0);
    }
}
