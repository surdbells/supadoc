<?php

declare(strict_types=1);

namespace App\Domain\Entity;

use App\Domain\Enum\SlotKind;
use App\Domain\Settings\ProcessClock;
use DateTimeImmutable;
use DateTimeZone;
use Doctrine\ORM\Mapping as ORM;
use Ramsey\Uuid\Uuid;

/**
 * A concrete, date-specific availability window a doctor published (OPEN) or a
 * span they marked unavailable (BLOCK). This is the doctor-managed layer on top
 * of the recurring `Specialist::weeklyHours`: when a specialist has any OPEN
 * slots in a window, those become the source of truth for that window; blocks
 * always subtract from whatever availability exists.
 *
 * The editor sends wall-clock times in the doctor's zone (`tz`; a request
 * without one is read as UTC, the legacy contract); instants are stored on the
 * process clock like every timestamp, and {@see toArray()} hands them back in
 * UTC. Rows published together by a repeating request share a `series_id`. "Booked" is not a stored
 * state: it is derived by matching a live appointment to an OPEN slot's start.
 */
#[ORM\Entity]
#[ORM\Table(name: 'availability_slots')]
#[ORM\Index(name: 'idx_slots_specialist_start', columns: ['specialist_id', 'starts_at'])]
#[ORM\Index(name: 'idx_slots_specialist_series', columns: ['specialist_id', 'series_id'])]
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

    /**
     * The unix time `startsAt` was written as — the clock-repair marker
     * (prod-migrate step 13). Set by every write of the start; NULL on rows
     * written before the clock fix.
     */
    #[ORM\Column(name: 'starts_epoch', type: 'bigint', nullable: true)]
    private ?int $startsEpoch = null;

    #[ORM\Column(type: 'string', length: 10, enumType: SlotKind::class)]
    private SlotKind $kind = SlotKind::OPEN;

    /** Optional reason on a BLOCK row (e.g. "Vacation, personal leave"). */
    #[ORM\Column(type: 'string', length: 200, nullable: true)]
    private ?string $reason = null;

    /** The repeating request that published this OPEN row (null for a one-time row or a block). */
    #[ORM\Column(name: 'series_id', type: 'uuid', nullable: true)]
    private ?string $seriesId = null;

    public function __construct(
        Specialist $specialist,
        DateTimeImmutable $startsAt,
        DateTimeImmutable $endsAt,
        SlotKind $kind = SlotKind::OPEN,
        ?string $reason = null,
        ?string $seriesId = null,
    ) {
        $this->id          = Uuid::uuid4()->toString();
        $this->specialist  = $specialist;
        $this->startsAt    = ProcessClock::normalize($startsAt);
        $this->endsAt      = ProcessClock::normalize($endsAt);
        $this->startsEpoch = $startsAt->getTimestamp();
        $this->kind        = $kind;
        $this->seriesId    = $seriesId !== null && $seriesId !== '' ? strtolower($seriesId) : null;
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

    /** The clock-repair marker: the unix time the start was written as (null on rows from before the clock fix). */
    public function getStartsEpoch(): ?int
    {
        return $this->startsEpoch;
    }

    public function getSeriesId(): ?string
    {
        return $this->seriesId;
    }

    /**
     * Move this row (a doctor's zone change, keeping its wall clock): both ends
     * on the process clock, and the clock-repair marker re-set from the instant.
     */
    public function reschedule(DateTimeImmutable $startsAt, DateTimeImmutable $endsAt): void
    {
        $this->startsAt    = ProcessClock::normalize($startsAt);
        $this->endsAt      = ProcessClock::normalize($endsAt);
        $this->startsEpoch = $startsAt->getTimestamp();
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

    /**
     * True if the half-open span [$start, $end) overlaps this slot at all — the
     * correct test for whether a block collides with a candidate slot (a
     * point-in-span `covers()` check misses a block that begins mid-slot).
     */
    public function overlaps(DateTimeImmutable $start, DateTimeImmutable $end): bool
    {
        return $start < $this->endsAt && $end > $this->startsAt;
    }

    /** @return array<string,mixed> */
    public function toArray(): array
    {
        return [
            'id'         => $this->id,
            'starts_at'  => $this->startsAt->setTimezone(new DateTimeZone('UTC'))->format(DATE_ATOM),
            'ends_at'    => $this->endsAt->setTimezone(new DateTimeZone('UTC'))->format(DATE_ATOM),
            'kind'       => $this->kind->value,
            'reason'     => $this->reason,
            'series_id'  => $this->seriesId,
        ];
    }
}
