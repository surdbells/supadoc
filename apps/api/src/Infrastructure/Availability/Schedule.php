<?php

declare(strict_types=1);

namespace App\Infrastructure\Availability;

/**
 * Everything {@see SlotGenerator} needs to know about one doctor's time, already
 * loaded and resolved: their consultation length, the recurring weekly grid in
 * play (the doctor's own hours, the weekday default, or none), their explicit
 * open slots and blocks, and the start times already taken. Instants are unix
 * seconds; the weekly grid is UTC wall-clock "HH:MM", like the doctor editor.
 */
final class Schedule
{
    /**
     * @param array<string, list<array{0:string,1:string}>> $weeklyHours weekday ("0"=Sun … "6"=Sat) => [start, end] "HH:MM" windows (UTC)
     * @param list<array{0:int,1:int}> $openSlots explicit OPEN slots [start, end)
     * @param list<array{0:int,1:int}> $blocks BLOCK spans [start, end)
     * @param list<int> $booked starts of live appointments (cancelled ones and expired proposals excluded)
     */
    public function __construct(
        public readonly int $slotMinutes = 30,
        public readonly array $weeklyHours = [],
        public readonly array $openSlots = [],
        public readonly array $blocks = [],
        public readonly array $booked = [],
    ) {
    }
}
