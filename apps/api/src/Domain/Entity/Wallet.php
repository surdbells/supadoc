<?php

declare(strict_types=1);

namespace App\Domain\Entity;

use Doctrine\ORM\Mapping as ORM;
use Ramsey\Uuid\Uuid;

/**
 * A patient's wallet for one currency (a patient may hold several — one per
 * currency, NGN by default). `balance` is a cached running total kept in step
 * with the append-only {@see WalletTransaction} ledger; every change goes through
 * {@see \App\Infrastructure\Service\WalletService} under a row lock so the cached
 * balance and the ledger never diverge. Money is decimal-as-string (never float).
 */
#[ORM\Entity]
#[ORM\Table(name: 'wallets')]
#[ORM\UniqueConstraint(name: 'uniq_wallet_patient_currency', columns: ['patient_id', 'currency'])]
#[ORM\HasLifecycleCallbacks]
class Wallet
{
    use TimestampsTrait;

    public const STATUS_ACTIVE = 'active';
    public const STATUS_FROZEN = 'frozen';

    #[ORM\Id]
    #[ORM\Column(type: 'uuid')]
    private string $id;

    #[ORM\Column(name: 'patient_id', type: 'uuid')]
    private string $patientId;

    #[ORM\Column(type: 'string', length: 3)]
    private string $currency;

    #[ORM\Column(type: 'decimal', precision: 18, scale: 2, options: ['default' => '0.00'])]
    private string $balance = '0.00';

    #[ORM\Column(type: 'string', length: 20, options: ['default' => self::STATUS_ACTIVE])]
    private string $status = self::STATUS_ACTIVE;

    public function __construct(string $patientId, string $currency)
    {
        $this->id        = Uuid::uuid4()->toString();
        $this->patientId = $patientId;
        $this->currency  = strtoupper($currency);
    }

    public function getId(): string
    {
        return $this->id;
    }

    public function getPatientId(): string
    {
        return $this->patientId;
    }

    public function getCurrency(): string
    {
        return $this->currency;
    }

    public function getBalance(): string
    {
        return $this->balance;
    }

    /** Set by WalletService only, inside the locked credit/debit transaction. */
    public function setBalance(string $balance): void
    {
        $this->balance = $balance;
    }

    public function getStatus(): string
    {
        return $this->status;
    }

    public function isActive(): bool
    {
        return $this->status === self::STATUS_ACTIVE;
    }

    public function toArray(): array
    {
        return [
            'currency' => $this->currency,
            'balance'  => $this->balance,
            'status'   => $this->status,
        ];
    }
}
