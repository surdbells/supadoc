<?php

declare(strict_types=1);

namespace App\Domain\Entity;

use Doctrine\ORM\Mapping as ORM;
use Ramsey\Uuid\Uuid;

/**
 * A doctor's payout beneficiary details. International by design (doctors are
 * abroad): account holder + bank + country + currency, and both IBAN and plain
 * account-number / SWIFT / routing so any region can be captured. One per
 * specialist. Never exposed outside the owning doctor + back office.
 */
#[ORM\Entity]
#[ORM\Table(name: 'payout_accounts')]
#[ORM\UniqueConstraint(name: 'uniq_payout_account_specialist', columns: ['specialist_id'])]
#[ORM\HasLifecycleCallbacks]
class PayoutAccount
{
    use TimestampsTrait;

    #[ORM\Id]
    #[ORM\Column(type: 'uuid')]
    private string $id;

    #[ORM\Column(name: 'specialist_id', type: 'uuid')]
    private string $specialistId;

    #[ORM\Column(name: 'account_holder', type: 'string', length: 200)]
    private string $accountHolder;

    #[ORM\Column(name: 'bank_name', type: 'string', length: 200)]
    private string $bankName;

    /** ISO country name or code of the bank. */
    #[ORM\Column(type: 'string', length: 100)]
    private string $country;

    /** Payout currency (ISO 4217), e.g. USD, GBP, EUR, NGN. */
    #[ORM\Column(type: 'string', length: 3)]
    private string $currency;

    #[ORM\Column(name: 'account_number', type: 'string', length: 64, nullable: true)]
    private ?string $accountNumber = null;

    #[ORM\Column(type: 'string', length: 64, nullable: true)]
    private ?string $iban = null;

    /** SWIFT / BIC. */
    #[ORM\Column(type: 'string', length: 32, nullable: true)]
    private ?string $swift = null;

    #[ORM\Column(name: 'routing_number', type: 'string', length: 64, nullable: true)]
    private ?string $routingNumber = null;

    public function __construct(string $specialistId)
    {
        $this->id           = Uuid::uuid4()->toString();
        $this->specialistId = $specialistId;
        $this->accountHolder = '';
        $this->bankName     = '';
        $this->country      = '';
        $this->currency     = 'USD';
    }

    public function getId(): string
    {
        return $this->id;
    }

    public function getCurrency(): string
    {
        return $this->currency;
    }

    public function setAccountHolder(string $v): void
    {
        $this->accountHolder = trim($v);
    }
    public function setBankName(string $v): void
    {
        $this->bankName = trim($v);
    }
    public function setCountry(string $v): void
    {
        $this->country = trim($v);
    }
    public function setCurrency(string $v): void
    {
        $this->currency = strtoupper(trim($v));
    }
    public function setAccountNumber(?string $v): void
    {
        $this->accountNumber = $v !== null && trim($v) !== '' ? trim($v) : null;
    }
    public function setIban(?string $v): void
    {
        $this->iban = $v !== null && trim($v) !== '' ? strtoupper(trim($v)) : null;
    }
    public function setSwift(?string $v): void
    {
        $this->swift = $v !== null && trim($v) !== '' ? strtoupper(trim($v)) : null;
    }
    public function setRoutingNumber(?string $v): void
    {
        $this->routingNumber = $v !== null && trim($v) !== '' ? trim($v) : null;
    }

    /** @return array<string,mixed> */
    public function toArray(): array
    {
        return [
            'account_holder'  => $this->accountHolder,
            'bank_name'       => $this->bankName,
            'country'         => $this->country,
            'currency'        => $this->currency,
            'account_number'  => $this->accountNumber,
            'iban'            => $this->iban,
            'swift'           => $this->swift,
            'routing_number'  => $this->routingNumber,
            'updated_at'      => $this->updatedAt?->format(DATE_ATOM),
        ];
    }
}
