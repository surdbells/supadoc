<?php

declare(strict_types=1);

namespace App\Infrastructure\Service;

use App\Domain\Entity\Specialist;
use App\Domain\Repository\AppointmentRepository;
use DateTimeImmutable;
use DateTimeZone;

/**
 * Turns a specialist's recurring weekly schedule into concrete, bookable slots:
 * the schedule grid, minus times already taken by live appointments, minus
 * anything in the past. All times are computed in UTC and the service formats
 * its own display labels so the client never has to reason about timezones.
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

    public function __construct(private readonly AppointmentRepository $appointments)
    {
    }

    /**
     * The next $maxDays days that have at least one open slot.
     *
     * @return list<array{date:string,weekday:string,day:string,slots:list<array{iso:string,label:string,time:string}>}>
     */
    public function availableDays(Specialist $specialist, int $maxDays = 7): array
    {
        $tz    = new DateTimeZone('UTC');
        $now   = new DateTimeImmutable('now', $tz);
        $lead  = $now->modify('+' . self::LEAD_MINUTES . ' minutes');
        $hours = $specialist->getWeeklyHours() ?? self::DEFAULT_HOURS;

        $from   = $now->setTime(0, 0);
        $to     = $from->modify('+' . (self::LOOKAHEAD_DAYS + 1) . ' days');
        $booked = $this->bookedKeys($specialist, $from, $to, $tz);

        $days = [];
        for ($i = 0; $i < self::LOOKAHEAD_DAYS && count($days) < $maxDays; $i++) {
            $date  = $from->modify("+{$i} days");
            $slots = [];
            foreach ($hours[(string) ((int) $date->format('w'))] ?? [] as [$start, $end]) {
                $cursor = $this->at($date, $start);
                $stop   = $this->at($date, $end);
                while ($cursor < $stop) {
                    if ($cursor >= $lead && !isset($booked[$cursor->format('Y-m-d H:i')])) {
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

    /** Is $when a valid, still-open slot for $specialist? (Booking guard.) */
    public function isSlotAvailable(Specialist $specialist, DateTimeImmutable $when): bool
    {
        $tz   = new DateTimeZone('UTC');
        $when = $when->setTimezone($tz);
        $lead = (new DateTimeImmutable('now', $tz))->modify('+' . self::LEAD_MINUTES . ' minutes');
        if ($when < $lead) {
            return false;
        }

        $hours    = $specialist->getWeeklyHours() ?? self::DEFAULT_HOURS;
        $inWindow = false;
        foreach ($hours[(string) ((int) $when->format('w'))] ?? [] as [$start, $end]) {
            $s = $this->at($when, $start);
            $e = $this->at($when, $end);
            if ($when >= $s && $when < $e
                && (int) (($when->getTimestamp() - $s->getTimestamp()) / 60) % self::SLOT_MINUTES === 0
            ) {
                $inWindow = true;
                break;
            }
        }
        if (!$inWindow) {
            return false;
        }

        $dayStart = $when->setTime(0, 0);
        $booked   = $this->bookedKeys($specialist, $dayStart, $dayStart->modify('+1 day'), $tz);

        return !isset($booked[$when->format('Y-m-d H:i')]);
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
