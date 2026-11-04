<?php

declare(strict_types=1);

namespace App\Infrastructure\Service;

use App\Domain\Entity\AvailabilitySlot;
use App\Domain\Entity\Specialist;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\AvailabilitySlotRepository;
use App\Domain\Settings\ProcessClock;
use App\Domain\Settings\TimeZones;
use DateTimeImmutable;
use DateTimeInterface;
use DateTimeZone;
use Doctrine\ORM\EntityManagerInterface;

/**
 * A doctor's time-zone change, optionally moving their future unbooked OPEN
 * times and BLOCK spans so they keep the same wall clock in the new zone
 * ("9:00 AM stays 9:00 AM"). Weekly hours need nothing: they are wall clock.
 *
 * All under the doctor's slot lock — the lock every booking takes — so a
 * booking that is committing can't land on a time being moved, and with the
 * doctor re-read under it, so two changes run one after the other. New positions
 * are computed for every movable row first, then rows are walked in their
 * original order: a row is skipped (left where it is) when its new start has
 * already passed, or — OPEN rows only, blocks may overlap anything — when an
 * OPEN row that stays put (booked, or skipped) or an earlier moved OPEN row
 * already starts there. Booked rows never move.
 */
final class DoctorTimeZoneService
{
    private const FLUSH_EVERY = 500;

    public function __construct(
        private readonly EntityManagerInterface $em,
        private readonly SlotLock $slotLock,
        private readonly AvailabilitySlotRepository $slots,
        private readonly AppointmentRepository $appointments,
    ) {
    }

    /**
     * Set `$s`'s zone (`$tz` already validated; `$source` 'auto' | 'manual') and,
     * with `$shift`, move their times when the zone actually changes.
     * `changed`: the effective zone changed; `from`: the effective zone it
     * changed from (as read under the lock).
     *
     * The doctor is re-read under the lock, so a change another request
     * committed while this one waited (a double-submitted Save, a second tab)
     * is what this one starts from: times are never moved twice, and an `auto`
     * detection never overwrites a zone that has been set meanwhile.
     *
     * @return array{changed:bool, shifted:?array{moved:int, skipped:int}, from:string}
     */
    public function change(Specialist $s, string $tz, string $source, bool $shift, DateTimeImmutable $now): array
    {
        return $this->em->wrapInTransaction(function () use ($s, $tz, $source, $shift, $now): array {
            // First, before any row or appointment is read.
            $this->slotLock->lockDoctor($s->getId());
            $this->em->refresh($s);

            $old = $s->timeZone();
            if ($source === 'auto' && ($s->getTimezoneSource() !== null || !TimeZones::isDetectable($tz))) {
                return ['changed' => false, 'shifted' => null, 'from' => $old->getName()];
            }
            $new     = TimeZones::zoneOr($tz);
            $changed = $old->getName() !== $new->getName();
            $shifted = $shift && $changed ? $this->shift($s, $old, $new, $now) : null;

            $s->setTimezone($tz, $source);
            $this->em->flush();

            return ['changed' => $changed, 'shifted' => $shifted, 'from' => $old->getName()];
        });
    }

    /** @return array{moved:int, skipped:int} */
    private function shift(Specialist $s, DateTimeZone $old, DateTimeZone $new, DateTimeImmutable $now): array
    {
        $rows = $this->slots->fromForSpecialist($s->getId(), $now);
        if ($rows === []) {
            return ['moved' => 0, 'skipped' => 0];
        }
        $lastStart = $rows[count($rows) - 1]->getStartsAt()->getTimestamp();
        $booked    = [];
        foreach ($this->appointments->takenStartsFor(
            [$s->getId()],
            ProcessClock::normalize($now),
            ProcessClock::normalize(new DateTimeImmutable('@' . ($lastStart + 60))),
            ProcessClock::normalize($now),
        ) as $row) {
            $booked[intdiv(self::ts($row['scheduled_at']), 60)] = true;
        }

        $nowMinute = $now->getTimestamp() - $now->getTimestamp() % 60;
        $stay      = [];   // starts (minutes) of OPEN rows that stay where they are
        $movable   = [];   // [row, newStart, newEnd]
        foreach ($rows as $row) {
            if (!$row->isOpen() && !$row->isBlock()) {
                continue;
            }
            $start = $row->getStartsAt()->getTimestamp();
            if ($row->isOpen() && isset($booked[intdiv($start, 60)])) {
                $stay[intdiv($start, 60)] = true;
                continue;
            }
            [$newStart, $newEnd] = self::moved($row, $old, $new);
            $movable[] = [$row, $newStart, $newEnd];
        }

        // A skipped OPEN row stays where it is, so nothing may move onto it
        // either: repeat the walk until no new row stays put (it only grows).
        do {
            $skip  = self::walk($movable, $stay, $nowMinute);
            $grown = false;
            foreach ($skip as $i => $isSkipped) {
                $row = $movable[$i][0];
                $at  = intdiv($row->getStartsAt()->getTimestamp(), 60);
                if ($isSkipped && $row->isOpen() && !isset($stay[$at])) {
                    $stay[$at] = true;
                    $grown     = true;
                }
            }
        } while ($grown);

        $moved   = 0;
        $skipped = 0;
        foreach ($movable as $i => [$row, $newStart, $newEnd]) {
            if ($skip[$i]) {
                $skipped++;
                continue;
            }
            $row->reschedule(new DateTimeImmutable('@' . $newStart), new DateTimeImmutable('@' . $newEnd));
            $moved++;
            if ($moved % self::FLUSH_EVERY === 0) {
                $this->em->flush();
            }
        }

        return ['moved' => $moved, 'skipped' => $skipped];
    }

    /**
     * Which movable rows are skipped, walking them in original order: the new
     * start has passed, or (OPEN) it is a staying row's start or an earlier
     * moved OPEN row's new start (the earliest original wins).
     *
     * @param list<array{0:AvailabilitySlot,1:int,2:int}> $movable
     * @param array<int,true> $stay starts (unix minutes) of OPEN rows that stay put
     * @return array<int,bool> by index into $movable
     */
    private static function walk(array $movable, array $stay, int $nowMinute): array
    {
        $out   = [];
        $taken = [];
        foreach ($movable as $i => [$row, $newStart]) {
            $key = intdiv($newStart, 60);
            $out[$i] = $newStart < $nowMinute || ($row->isOpen() && (isset($stay[$key]) || isset($taken[$key])));
            if (!$out[$i] && $row->isOpen()) {
                $taken[$key] = true;
            }
        }

        return $out;
    }

    /**
     * Where a row goes to keep its wall clock: an entire-day block becomes the
     * same local day in the new zone; any other row keeps its local date, time
     * and length.
     *
     * @return array{0:int,1:int}
     */
    public static function moved(AvailabilitySlot $row, DateTimeZone $old, DateTimeZone $new): array
    {
        $start = $row->getStartsAt()->getTimestamp();
        $end   = $row->getEndsAt()->getTimestamp();
        $ymd   = TimeZones::localDate($start, $old);
        if ($row->isBlock() && [$start, $end] === TimeZones::localDayBounds($ymd, $old)) {
            return TimeZones::localDayBounds($ymd, $new);
        }
        $newStart = TimeZones::wallToInstant($ymd, TimeZones::minutesOfDay($start, $old), $new);

        return [$newStart, $newStart + ($end - $start)];
    }

    /** A hydrated (process-zone) value as unix seconds. */
    private static function ts(mixed $value): int
    {
        return $value instanceof DateTimeInterface
            ? $value->getTimestamp()
            : (new DateTimeImmutable((string) $value, ProcessClock::zone()))->getTimestamp();
    }
}
