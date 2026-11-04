<?php

declare(strict_types=1);

namespace App\Infrastructure\Availability;

use DateTimeZone;

/**
 * Everything {@see SlotGenerator} needs to know about one doctor's time, already
 * loaded and resolved: their consultation length, the recurring weekly grid in
 * play (the doctor's own hours, the weekday default, or none), their explicit
 * open slots and blocks, the start times already taken, and the zone their
 * clock runs on. Instants are unix seconds; the weekly grid is wall clock
 * "HH:MM" in `$zone` (the doctor's own time zone).
 */
final class Schedule
{
    /**
     * @param array<string, list<array{0:string,1:string}>> $weeklyHours weekday ("0"=Sun … "6"=Sat) => [start, end] "HH:MM" windows, wall clock in $zone ("24:00" = midnight)
     * @param list<array{0:int,1:int}> $openSlots explicit OPEN slots [start, end)
     * @param list<array{0:int,1:int}> $blocks BLOCK spans [start, end)
     * @param list<int> $booked starts of live appointments (cancelled ones and expired proposals excluded)
     * @param DateTimeZone $zone the zone the weekly grid and the explicit-slot days are read in
     */
    public function __construct(
        public readonly int $slotMinutes = 30,
        public readonly array $weeklyHours = [],
        public readonly array $openSlots = [],
        public readonly array $blocks = [],
        public readonly array $booked = [],
        public readonly DateTimeZone $zone = new DateTimeZone('UTC'),
    ) {
    }
}
