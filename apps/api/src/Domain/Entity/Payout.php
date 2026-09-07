<?php

declare(strict_types=1);

namespace App\Domain\Entity;

use DateTimeImmutable;
use Doctrine\ORM\Mapping as ORM;
use Ramsey\Uuid\Uuid;

/**
 * A doctor's manual payout request against their available earnings. Flows
 * pending → approved → paid (or rejected). The beneficiary details are snapshot
 * at request time so a later account edit can't rewrite history. Money is
 * bcmath decimal-string, scale 2.
 */
#[ORM\Entity]
#[ORM\Table(name: 'payouts')]
#[ORM\Index(name: 'idx_payouts_specialist', columns: ['specialist_id', 'created_at'])]
#[ORM\HasLifecycleCallbacks]
class Payout
{
    use TimestampsTrait;

    public const STATUS_PENDING  = 'pending';
    public const STATUS_APPROVED = 'approved';
    public const STATUS_PAID     = 'paid';
    public const STATUS_REJECTED = 'rejected';

    #[ORM\Id]
    #[ORM\Column(type: 'uuid')]
    private string $id;

    #[ORM\Column(name: 'specialist_id', type: 'uuid')]
    private string $specialistId;

    #[ORM\Column(name: 'specialist_name', type: 'string', length: 200)]
    private string $specialistName;

    #[ORM\Column(type: 'decimal', precision: 18, scale: 2)]
    private string $amount;

    #[ORM\Column(type: 'string', length: 3)]
    private string $currency;

    #[ORM\Column(type: 'string', length: 20)]
    private string $status = self::STATUS_PENDING;

    #[ORM\Column(type: 'text', nullable: true)]
    private ?string $note = null;

    #[ORM\Column(name: 'admin_note', type: 'text', nullable: true)]
    private ?string $adminNote = null;

    #[ORM\Column(name: 'decided_by', type: 'string', length: 200, nullable: true)]
    private ?string $decidedBy = null;

    #[ORM\Column(type: 'string', length: 120, nullable: true)]
    private ?string $reference = null;

    /** Snapshot of the PayoutAccount at request time. @var array<string,mixed>|null */
    #[ORM\Column(type: 'json', nullable: true)]
    private ?array $account = null;

    #[ORM\Column(name: 'decided_at', type: 'datetime_immutable', nullable: true)]
    private ?DateTimeImmutable $decidedAt = null;

    #[ORM\Column(name: 'paid_at', type: 'datetime_immutable', nullable: true)]
    private ?DateTimeImmutable $paidAt = null;

    /** @param array<string,mixed>|null $account */
    public function __construct(
        string $specialistId,
        string $specialistName,
        string $amount,
        string $currency,
        ?array $account = null,
        ?string $note = null,
    ) {
        $this->id             = Uuid::uuid4()->toString();
        $this->specialistId   = $specialistId;
        $this->specialistName = $specialistName;
        $this->amount         = $amount;
        $this->currency       = strtoupper($currency);
        $this->account        = $account;
        $this->note           = $note !== null && trim($note) !== '' ? trim($note) : null;
    }

    public function getId(): string
    {
        return $this->id;
    }
    public function getSpecialistId(): string
    {
        return $this->specialistId;
    }
    public function getStatus(): string
    {
        return $this->status;
    }
    public function getAmount(): string
    {
        return $this->amount;
    }

    public function approve(string $decidedBy, ?string $adminNote = null): void
    {
        $this->status    = self::STATUS_APPROVED;
        $this->decidedBy = $decidedBy;
        $this->decidedAt = new DateTimeImmutable();
        if ($adminNote !== null && trim($adminNote) !== '') {
            $this->adminNote = trim($adminNote);
        }
    }

    public function markPaid(string $decidedBy, ?string $reference = null): void
    {
        $this->status    = self::STATUS_PAID;
        $this->decidedBy = $decidedBy;
        $this->paidAt    = new DateTimeImmutable();
        if ($this->decidedAt === null) {
            $this->decidedAt = $this->paidAt;
        }
        if ($reference !== null && trim($reference) !== '') {
            $this->reference = trim($reference);
        }
    }

    public function reject(string $decidedBy, ?string $adminNote = null): void
    {
        $this->status    = self::STATUS_REJECTED;
        $this->decidedBy = $decidedBy;
        $this->decidedAt = new DateTimeImmutable();
        if ($adminNote !== null && trim($adminNote) !== '') {
            $this->adminNote = trim($adminNote);
        }
    }

    /** @return array<string,mixed> */
    public function toArray(): array
    {
        return [
            'id'              => $this->id,
            'specialist_id'   => $this->specialistId,
            'specialist_name' => $this->specialistName,
            'amount'          => $this->amount,
            'currency'        => $this->currency,
            'status'          => $this->status,
            'note'            => $this->note,
            'admin_note'      => $this->adminNote,
            'decided_by'      => $this->decidedBy,
            'reference'       => $this->reference,
            'account'         => $this->account,
            'requested_at'    => $this->createdAt->format(DATE_ATOM),
            'decided_at'      => $this->decidedAt?->format(DATE_ATOM),
            'paid_at'         => $this->paidAt?->format(DATE_ATOM),
        ];
    }
}
