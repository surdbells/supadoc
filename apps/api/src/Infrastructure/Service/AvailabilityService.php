<?php

declare(strict_types=1);

namespace App\Infrastructure\Service;

use App\Domain\Entity\AvailabilitySlot;
use App\Domain\Entity\Specialist;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\AvailabilitySlotRepository;
use DateTimeImmutable;
use DateTimeZone;

/**
 * Turns a specialist's schedule into concrete, bookable slots. Two layers:
 *
 *   1. Explicit date-specific slots the doctor published ({@see AvailabilitySlot}).
 *      When a specialist has ANY open slot from now on, those become the source
 *      of truth — the recurring grid is no longer generated for them.
 *   2. The recurring weekly grid (`Specialist::weeklyHours`) — the fallback for a
 *      specialist who hasn't used the availability editor.
 *
 * Blocks always subtract, and taken appointment times always subtract, from
 * whichever layer is in play. All times are computed in UTC and the service
 * formats its own display labels so the client never reasons about timezones.
 */
final class AvailabilityService
{
    private const SLOT_MINUTES   = 30;
    private const LOOKAHEAD_DAYS = 21; // scan window to collect available days
    private const LEAD_MINUTES   = 60; // earliest bookable slot = now + 1h

    /** Fallback when a specialist has no schedule: weekdays 09:00–17:00. */
    private const DEFAULT_HOURS = [
        '1' => [['09:00', '17:00']],
        '2' => [['09:00', '17:00']],
        '3' => [['09:00', '17:00']],
        '4' => [['09:00', '17:00']],
        '5' => [['09:00', '17:00']],
    ];

    public function __construct(
        private readonly AppointmentRepository $appointments,
        private readonly AvailabilitySlotRepository $slots,
    ) {
    }

    /**
     * The next $maxDays days that have at least one open slot.
     *
     * @return list<array{date:string,weekday:string,day:string,slots:list<array{iso:string,label:string,time:string}>}>
     */
    public function availableDays(Specialist $specialist, int $maxDays = 7): array
    {
        $tz   = new DateTimeZone('UTC');
        $now  = new DateTimeImmutable('now', $tz);
        $lead = $now->modify('+' . self::LEAD_MINUTES . ' minutes');

        $from   = $now->setTime(0, 0);
        $to     = $from->modify('+' . (self::LOOKAHEAD_DAYS + 1) . ' days');
        $booked = $this->bookedKeys($specialist, $from, $to, $tz);

        $slotRows = $this->slots->forSpecialistBetween($specialist->getId(), $from, $to);
        $blocks   = array_values(array_filter($slotRows, static fn (AvailabilitySlot $s): bool => $s->isBlock()));
        // Decide explicit-vs-weekly over the SAME [from, to) window we generate,
        // so a far-future open slot outside this window can't switch the doctor
        // to explicit mode and silently zero their near-term availability.
        $useExplicit = $this->slots->hasOpenSlotsSince($specialist->getId(), $now, $to);

        return $useExplicit
            ? $this->daysFromExplicit($slotRows, $blocks, $booked, $lead, $tz, $maxDays)
            : $this->daysFromWeekly($specialist, $blocks, $booked, $from, $lead, $maxDays);
    }

    /** Is $when a valid, still-open slot for $specialist? (Booking guard.) */
    public function isSlotAvailable(Specialist $specialist, DateTimeImmutable $when): bool
    {
        $tz   = new DateTimeZone('UTC');
        $when = $when->setTimezone($tz);
        $now  = new DateTimeImmutable('now', $tz);
        $lead = $now->modify('+' . self::LEAD_MINUTES . ' minutes');
        if ($when < $lead) {
            return false;
        }

        $dayStart = $when->setTime(0, 0);
        $dayEnd   = $dayStart->modify('+1 day');
        $slotRows = $this->slots->forSpecialistBetween($specialist->getId(), $dayStart, $dayEnd);
        $blocks   = array_values(array_filter($slotRows, static fn (AvailabilitySlot $s): bool => $s->isBlock()));

        // Pick the layer over the same window the day listing scans, so the
        // booking guard and the listing always agree on explicit-vs-weekly mode.
        $scanFrom    = $now->setTime(0, 0);
        $scanTo      = $scanFrom->modify('+' . (self::LOOKAHEAD_DAYS + 1) . ' days');
        $useExplicit = $this->slots->hasOpenSlotsSince($specialist->getId(), $now, $scanTo);

        // Resolve the requested slot's [start, end) span for the active layer so a
        // block overlapping ANY part of it (not just its start) rejects it.
        if ($useExplicit) {
            $slotEnd = null;
            foreach ($slotRows as $slot) {
                if ($slot->isOpen()
                    && $slot->getStartsAt()->setTimezone($tz)->format('Y-m-d H:i') === $when->format('Y-m-d H:i')
                ) {
                    $slotEnd = $slot->getEndsAt()->setTimezone($tz);
                    break;
                }
            }
            if ($slotEnd === null) {
                return false;
            }
        } else {
            if (!$this->onWeeklyGrid($specialist, $when)) {
                return false;
            }
            $slotEnd = $when->modify('+' . self::SLOT_MINUTES . ' minutes');
        }

        if ($this->withinBlock($when, $slotEnd, $blocks)) {
            return false;
        }

        $booked = $this->bookedKeys($specialist, $dayStart, $dayEnd, $tz);

        return !isset($booked[$when->format('Y-m-d H:i')]);
    }

    /** Does $when land exactly on the specialist's recurring weekly grid? */
    private function onWeeklyGrid(Specialist $specialist, DateTimeImmutable $when): bool
    {
        $hours = $specialist->getWeeklyHours() ?? self::DEFAULT_HOURS;
        foreach ($hours[(string) ((int) $when->format('w'))] ?? [] as [$start, $end]) {
            $s = $this->at($when, $start);
            $e = $this->at($when, $end);
            if ($when >= $s && $when < $e
                && (int) (($when->getTimestamp() - $s->getTimestamp()) / 60) % self::SLOT_MINUTES === 0
            ) {
                return true;
            }
        }

        return false;
    }

    /**
     * Days built from the doctor's explicit open slots (minus booked / blocked).
     *
     * @param list<AvailabilitySlot> $slotRows
     * @param list<AvailabilitySlot> $blocks
     * @param array<string,true> $booked
     * @return list<array{date:string,weekday:string,day:string,slots:list<array{iso:string,label:string,time:string}>}>
     */
    private function daysFromExplicit(
        array $slotRows,
        array $blocks,
        array $booked,
        DateTimeImmutable $lead,
        DateTimeZone $tz,
        int $maxDays,
    ): array {
        $byDay = [];
        foreach ($slotRows as $slot) {
            if (!$slot->isOpen()) {
                continue;
            }
            $start = $slot->getStartsAt()->setTimezone($tz);
            $end   = $slot->getEndsAt()->setTimezone($tz);
            if ($start < $lead
                || isset($booked[$start->format('Y-m-d H:i')])
                || $this->withinBlock($start, $end, $blocks)
            ) {
                continue;
            }
            $byDay[$start->format('Y-m-d')][] = [
                'iso'   => $start->format(DATE_ATOM),
                'label' => $start->format('g:i A'),
                'time'  => $start->format('H:i'),
            ];
        }
        ksort($byDay);

        $days = [];
        foreach ($byDay as $date => $slots) {
            if (count($days) >= $maxDays) {
                break;
            }
            $d = new DateTimeImmutable($date, $tz);
            $days[] = [
                'date'    => $date,
                'weekday' => $d->format('D'),
                'day'     => $d->format('j'),
                'slots'   => $slots,
            ];
        }

        return $days;
    }

    /**
     * Days built from the recurring weekly grid (minus booked / blocked).
     *
     * @param list<AvailabilitySlot> $blocks
     * @param array<string,true> $booked
     * @return list<array{date:string,weekday:string,day:string,slots:list<array{iso:string,label:string,time:string}>}>
     */
    private function daysFromWeekly(
        Specialist $specialist,
        array $blocks,
        array $booked,
        DateTimeImmutable $from,
        DateTimeImmutable $lead,
        int $maxDays,
    ): array {
        $hours = $specialist->getWeeklyHours() ?? self::DEFAULT_HOURS;

        $days = [];
        for ($i = 0; $i < self::LOOKAHEAD_DAYS && count($days) < $maxDays; $i++) {
            $date  = $from->modify("+{$i} days");
            $slots = [];
            foreach ($hours[(string) ((int) $date->format('w'))] ?? [] as [$start, $end]) {
                $cursor = $this->at($date, $start);
                $stop   = $this->at($date, $end);
                while ($cursor < $stop) {
                    $cursorEnd = $cursor->modify('+' . self::SLOT_MINUTES . ' minutes');
                    if ($cursor >= $lead
                        && !isset($booked[$cursor->format('Y-m-d H:i')])
                        && !$this->withinBlock($cursor, $cursorEnd, $blocks)
                    ) {
                        $slots[] = [
                            'iso'   => $cursor->format(DATE_ATOM),
                            'label' => $cursor->format('g:i A'),
                            'time'  => $cursor->format('H:i'),
                        ];
                    }
                    $cursor = $cursor->modify('+' . self::SLOT_MINUTES . ' minutes');
                }
            }
            if ($slots !== []) {
                $days[] = [
                    'date'    => $date->format('Y-m-d'),
                    'weekday' => $date->format('D'),
                    'day'     => $date->format('j'),
                    'slots'   => $slots,
                ];
            }
        }

        return $days;
    }

    /**
     * Does any block overlap the candidate slot [$start, $end)? Uses span-overlap
     * (not point membership) so a block beginning mid-slot still rejects it.
     *
     * @param list<AvailabilitySlot> $blocks
     */
    private function withinBlock(DateTimeImmutable $start, DateTimeImmutable $end, array $blocks): bool
    {
        foreach ($blocks as $block) {
            if ($block->overlaps($start, $end)) {
                return true;
            }
        }

        return false;
    }

    /** @return array<string,true> keys "Y-m-d H:i" of already-taken slots */
    private function bookedKeys(
        Specialist $specialist,
        DateTimeImmutable $from,
        DateTimeImmutable $to,
        DateTimeZone $tz,
    ): array {
        $keys = [];
        foreach ($this->appointments->forSpecialistBetween($specialist->getId(), $from, $to) as $appt) {
            $keys[$appt->getScheduledAt()->setTimezone($tz)->format('Y-m-d H:i')] = true;
        }

        return $keys;
    }

    private function at(DateTimeImmutable $date, string $hm): DateTimeImmutable
    {
        [$h, $m] = array_map('intval', explode(':', $hm));

        return $date->setTime($h, $m);
    }
}
