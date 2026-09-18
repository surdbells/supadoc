<?php

declare(strict_types=1);

namespace App\Domain\Entity;

use App\Domain\Enum\SlotKind;
use DateTimeImmutable;
use Doctrine\ORM\Mapping as ORM;
use Ramsey\Uuid\Uuid;

/**
 * A concrete, date-specific availability window a doctor published (OPEN) or a
 * span they marked unavailable (BLOCK). This is the doctor-managed layer on top
 * of the recurring `Specialist::weeklyHours`: when a specialist has any OPEN
 * slots in a window, those become the source of truth for that window; blocks
 * always subtract from whatever availability exists.
 *
 * Times are stored (like the rest of the scheduling code) as UTC wall-clock —
 * the client sends "HH:MM" for a date and the API never reasons about the
 * viewer's timezone. "Booked" is not a stored state: it is derived by matching
 * a live appointment to an OPEN slot's start.
 */
#[ORM\Entity]
#[ORM\Table(name: 'availability_slots')]
#[ORM\Index(name: 'idx_slots_specialist_start', columns: ['specialist_id', 'starts_at'])]
#[ORM\HasLifecycleCallbacks]
class AvailabilitySlot
{
    use TimestampsTrait;

    #[ORM\Id]
    #[ORM\Column(type: 'uuid')]
    private string $id;

    #[ORM\ManyToOne(targetEntity: Specialist::class)]
    #[ORM\JoinColumn(name: 'specialist_id', referencedColumnName: 'id', nullable: false)]
    private Specialist $specialist;

    #[ORM\Column(name: 'starts_at', type: 'datetime_immutable')]
    private DateTimeImmutable $startsAt;

    #[ORM\Column(name: 'ends_at', type: 'datetime_immutable')]
    private DateTimeImmutable $endsAt;

    #[ORM\Column(type: 'string', length: 10, enumType: SlotKind::class)]
    private SlotKind $kind = SlotKind::OPEN;

    /** Optional reason on a BLOCK row (e.g. "Vacation, personal leave"). */
    #[ORM\Column(type: 'string', length: 200, nullable: true)]
    private ?string $reason = null;

    public function __construct(
        Specialist $specialist,
        DateTimeImmutable $startsAt,
        DateTimeImmutable $endsAt,
        SlotKind $kind = SlotKind::OPEN,
        ?string $reason = null,
    ) {
        $this->id         = Uuid::uuid4()->toString();
        $this->specialist = $specialist;
        $this->startsAt   = $startsAt;
        $this->endsAt     = $endsAt;
        $this->kind       = $kind;
        $this->setReason($reason);
    }

    public function getId(): string
    {
        return $this->id;
    }

    public function getSpecialist(): Specialist
    {
        return $this->specialist;
    }

    public function getStartsAt(): DateTimeImmutable
    {
        return $this->startsAt;
    }

    public function getEndsAt(): DateTimeImmutable
    {
        return $this->endsAt;
    }

    public function getKind(): SlotKind
    {
        return $this->kind;
    }

    public function isOpen(): bool
    {
        return $this->kind === SlotKind::OPEN;
    }

    public function isBlock(): bool
    {
        return $this->kind === SlotKind::BLOCK;
    }

    public function getReason(): ?string
    {
        return $this->reason;
    }

    public function setReason(?string $reason): void
    {
        $this->reason = $reason !== null && trim($reason) !== '' ? trim($reason) : null;
    }

    /** True if this span covers $when (start inclusive, end exclusive). */
    public function covers(DateTimeImmutable $when): bool
    {
        return $when >= $this->startsAt && $when < $this->endsAt;
    }

    /** @return array<string,mixed> */
    public function toArray(): array
    {
        return [
            'id'         => $this->id,
            'starts_at'  => $this->startsAt->format(DATE_ATOM),
            'ends_at'    => $this->endsAt->format(DATE_ATOM),
            'kind'       => $this->kind->value,
            'reason'     => $this->reason,
        ];
    }
}
