<?php

declare(strict_types=1);

namespace App\Infrastructure\Service;

use App\Domain\Entity\Specialist;
use App\Domain\Enum\SlotKind;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\AvailabilitySlotRepository;
use App\Domain\Settings\BookingSettings;
use App\Infrastructure\Availability\BookingFrame;
use App\Infrastructure\Availability\Schedule;
use App\Infrastructure\Availability\SlotGenerator;
use DateTimeImmutable;
use DateTimeInterface;
use DateTimeZone;

/**
 * Turns a specialist's schedule into concrete, bookable times — for the
 * booking calendar, the directory, the suggestions and the booking guard,
 * which all go through the same pure {@see SlotGenerator}:
 *
 *   1. Per UTC day, explicit date-specific slots the doctor published win: a
 *      day with any OPEN slot offers exactly those.
 *   2. Every other day offers the recurring weekly grid
 *      (`Specialist::weeklyHours`), stepped by the doctor's consultation length.
 *      An approved doctor with no weekly hours who publishes nothing in the
 *      booking window gets weekdays 09:00–17:00; nobody else gets made-up hours.
 *
 * Blocks and live appointments (by overlap) subtract from both. A doctor who
 * isn't approved (onboarding, rejected, suspended) or was removed has no times
 * at all. The bookable window is [now + lead, now + horizon) from
 * {@see BookingSettings}; patients are held to the horizon, staff and doctors
 * are not (their calendar is a {@see STAFF_HORIZON_DAYS} window that ignores
 * the doctor's bookings switch). Instants are unix seconds inside; days are
 * grouped in the viewer's zone (default: the clinic's), and nothing assumes
 * PHP's default timezone — values handed to Doctrine are converted to it
 * explicitly (like FollowUpService).
 */
final class AvailabilityService
{
    /** How far ahead the staff / doctor calendar reaches (they aren't held to the patient horizon). */
    public const STAFF_HORIZON_DAYS = 365;

    /** The legacy `?days=N` listing scans this many UTC days from today. */
    private const LEGACY_SCAN_DAYS = 21;

    /** A first-opening scan widens a week, two more weeks, then the rest of the window. */
    private const SCAN_CHUNKS = [7, 14];

    private const DAY = 86400;

    /** Fallback when an approved specialist has no schedule: weekdays 09:00–17:00. */
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
        private readonly ?BookingSettings $settings = null,
    ) {
    }

    // ----- Settings + the frame -----

    /** How many days ahead patients may book. */
    public function horizonDays(): int
    {
        return $this->settings?->get('horizon_days') ?? BookingSettings::default('horizon_days');
    }

    /** The minimum notice, in minutes, before a consultation can be booked. */
    public function leadMinutes(): int
    {
        return $this->settings?->get('lead_minutes') ?? BookingSettings::default('lead_minutes');
    }

    /** The minimum notice in words, e.g. "an hour", "90 minutes", "2 hours". */
    public function leadLabel(): string
    {
        $minutes = $this->leadMinutes();

        return match (true) {
            $minutes === 60      => 'an hour',
            $minutes % 60 === 0  => ($minutes / 60) . ' hours',
            default              => $minutes . ' minutes',
        };
    }

    /** A day with this many open times or fewer reads as "few left". */
    public function fewLeft(): int
    {
        return $this->settings?->get('few_left') ?? BookingSettings::default('few_left');
    }

    /**
     * "Now" seen from $tz (default: the clinic's zone), with the bookable
     * window: the patient horizon, or — `$enforceHorizon` false, for the staff
     * and doctor calendars — {@see STAFF_HORIZON_DAYS} with the doctor's
     * bookings switch ignored.
     */
    public function frame(?DateTimeZone $tz = null, ?DateTimeImmutable $now = null, bool $enforceHorizon = true): BookingFrame
    {
        return new BookingFrame(
            $tz ?? BookingFrame::zone(null),
            ($now ?? new DateTimeImmutable())->getTimestamp(),
            $this->leadMinutes(),
            $enforceHorizon ? $this->horizonDays() : self::STAFF_HORIZON_DAYS,
            $enforceHorizon,
        );
    }

    /** Is $when past the patient booking horizon (now + horizon_days)? */
    public function isBeyondHorizon(DateTimeImmutable $when, ?DateTimeImmutable $now = null): bool
    {
        return $when->getTimestamp() >= $this->frame(null, $now)->bookableUntil;
    }

    // ----- The booking guard -----

    /**
     * Is $when an open consultation time for $specialist? Exactly the calendar's
     * rules: approved doctor, at least the lead time ahead, on an explicit slot
     * or the weekly grid of its day, not blocked, not overlapping a booking.
     * Patients are held to the horizon (`$enforceHorizon`); staff and doctor
     * paths pass false. Moving an appointment, pass its id as
     * `$ignoreAppointmentId`: its own current time doesn't stand in its way.
     */
    public function isSlotAvailable(
        Specialist $specialist,
        DateTimeImmutable $when,
        bool $enforceHorizon = true,
        ?DateTimeImmutable $now = null,
        ?string $ignoreAppointmentId = null,
    ): bool {
        if (!self::hasTimes($specialist)) {
            return false;
        }
        $frame = $this->frame(null, $now);
        $at    = $when->getTimestamp();
        $at   -= $at % 60; // the calendar's times are whole minutes
        if ($at < $frame->bookableFrom || ($enforceHorizon && $at >= $frame->bookableUntil)) {
            return false;
        }
        $schedule = $this->schedules([$specialist], $at, $at + 1, $frame, null, $ignoreAppointmentId)[$specialist->getId()];

        return SlotGenerator::isOpenAt($schedule, $at, $frame->bookableFrom);
    }

    // ----- The booking calendar -----

    /**
     * One specialist's calendar for the dates $from … $to (the frame's zone; the
     * caller keeps it to a 6-week grid): a status per day, and the next opening
     * anywhere in the booking window. Statuses: past / beyond (outside today …
     * bookable_until), available / few (open times left), full (had times, all
     * taken), blocked (the doctor blocked what there was), closed (no hours).
     * Never block reasons or booked counts. A staff frame
     * (`frame(…, enforceHorizon: false)`) reaches a year ahead and shows a
     * doctor switched off for bookings too.
     *
     * @return array{tz:string, today:string, bookable_from:string, bookable_until:string, horizon_days:int, slot_minutes:int, next_available:?string, days:list<array{date:string, status:string, open:int, first:?string}>}
     */
    public function range(Specialist $specialist, string $from, string $to, BookingFrame $frame): array
    {
        $live     = self::isLive($specialist, $frame);
        $lo       = max($from, $frame->today);
        $hi       = min($to, $frame->bookableUntilDate);
        $schedule = null;
        if ($live && $lo <= $hi) {
            $schedule = $this->schedules([$specialist], $frame->day($lo)['start'], $frame->day($hi)['end'], $frame)[$specialist->getId()];
        }
        ['days' => $days, 'next' => $next] = self::calendarDays($schedule, $from, $to, $frame, $this->fewLeft());

        // The next opening is searched across the whole window: before the range
        // (when it starts after today) and after it (when it held none).
        if ($live && ($next === null || $from > $frame->today)) {
            $scanFrom = $from > $frame->today ? $frame->today : BookingFrame::addDays($to, 1);
            $found    = $this->firstOpenings([$specialist], $frame, $scanFrom, $frame->bookableUntilDate)[$specialist->getId()] ?? null;
            if ($found !== null && ($next === null || $found['first_at'] < $next)) {
                $next = $found['first_at'];
            }
        }

        return [
            'tz'             => $frame->tz->getName(),
            'today'          => $frame->today,
            'bookable_from'  => $frame->bookableFromDate,
            'bookable_until' => $frame->bookableUntilDate,
            'horizon_days'   => $frame->horizonDays,
            'slot_minutes'   => $specialist->getSlotMinutes(),
            'next_available' => $next !== null ? BookingFrame::iso($next) : null,
            'days'           => $days,
        ];
    }

    /**
     * The calendar's days for $from … $to from a loaded schedule (null: the
     * doctor has no times) — pure, so the statuses are unit-tested. `next` is
     * the first open time in the range.
     *
     * @return array{days:list<array{date:string, status:string, open:int, first:?string}>, next:?int}
     */
    public static function calendarDays(?Schedule $schedule, string $from, string $to, BookingFrame $frame, int $fewLeft): array
    {
        $lo    = max($from, $frame->today);
        $hi    = min($to, $frame->bookableUntilDate);
        $stats = [];
        if ($schedule !== null && $lo <= $hi) {
            $window  = $frame->days($lo, $hi);
            $start   = $window[0]['start'];
            $end     = $window[count($window) - 1]['end'];
            $buckets = self::byDay(SlotGenerator::generate($schedule, $start, $end, $frame->bookableFrom, $frame->bookableUntil), $window);
            foreach ($window as $i => $day) {
                $s = ['open' => 0, 'first' => null, 'taken' => false, 'blocked' => false];
                foreach ($buckets[$i] ?? [] as $c) {
                    if ($c['state'] === SlotGenerator::OPEN) {
                        $s['open']++;
                        $s['first'] ??= $c['start'];
                    } elseif ($c['state'] === SlotGenerator::TAKEN) {
                        $s['taken'] = true;
                    } elseif ($c['state'] === SlotGenerator::BLOCKED) {
                        $s['blocked'] = true;
                    }
                }
                $stats[$day['date']] = $s;
            }
        }

        // Counted, not compared as strings: "10000-01-01" sorts before "9999-12-31".
        $days = [];
        $next = null;
        $n    = BookingFrame::daysBetween($from, $to);
        for ($i = 0; $i <= $n; $i++) {
            $date = BookingFrame::addDays($from, $i);
            $s    = $stats[$date] ?? null;
            $status = match (true) {
                $date < $frame->today              => 'past',
                $date > $frame->bookableUntilDate  => 'beyond',
                $s === null                        => 'closed',
                $s['open'] > 0                     => $s['open'] <= $fewLeft ? 'few' : 'available',
                $s['taken']                        => 'full',
                $s['blocked']                      => 'blocked',
                default                            => 'closed',
            };
            $first = $s['first'] ?? null;
            $next ??= $first;
            $days[] = [
                'date'   => $date,
                'status' => $status,
                'open'   => $s['open'] ?? 0,
                'first'  => $first !== null ? BookingFrame::iso($first) : null,
            ];
        }

        return ['days' => $days, 'next' => $next];
    }

    /**
     * The open times on one date (the frame's zone), each with its instant, the
     * zone's "HH:mm" and "9:30 AM", and its part of the day. Empty outside
     * today … bookable_until, or for a doctor who can't be booked (a staff
     * frame: a year ahead, the bookings switch ignored).
     *
     * @return array{date:string, tz:string, slots:list<array{iso:string, time:string, label:string, period:string}>}
     */
    public function daySlots(Specialist $specialist, string $date, BookingFrame $frame): array
    {
        $slots = [];
        if (self::isLive($specialist, $frame) && $frame->isBookableDate($date)) {
            $day      = $frame->day($date);
            $schedule = $this->schedules([$specialist], $day['start'], $day['end'], $frame)[$specialist->getId()];
            foreach (SlotGenerator::generate($schedule, $day['start'], $day['end'], $frame->bookableFrom, $frame->bookableUntil) as $c) {
                if ($c['state'] === SlotGenerator::OPEN) {
                    $slots[] = $frame->slot($c['start'], $day);
                }
            }
        }

        return ['date' => $date, 'tz' => $frame->tz->getName(), 'slots' => $slots];
    }

    // ----- Many doctors at once (directory, suggestions) -----

    /**
     * For each specialist, the first date in $from … $to (the frame's zone,
     * clipped to today … bookable_until) with an open time — in $partOfDay when
     * given: {date, open_slots, first_at, slots} (unix starts of that date's
     * matching times), or null. Scans a week, two more, then the rest, and only
     * re-queries the doctors still unresolved: about three queries per step for
     * any number of doctors.
     *
     * @param list<Specialist> $specialists
     * @return array<string, array{date:string, open_slots:int, first_at:int, slots:list<int>}|null>
     */
    public function firstOpenings(array $specialists, BookingFrame $frame, string $from, string $to, ?string $partOfDay = null): array
    {
        $out     = [];
        $pending = [];
        foreach ($specialists as $s) {
            $out[$s->getId()] = null;
            if (self::isLive($s, $frame)) {
                $pending[$s->getId()] = $s;
            }
        }
        $from = max($from, $frame->today);
        $to   = min($to, $frame->bookableUntilDate);
        if ($pending === [] || $from > $to) {
            return $out;
        }
        $publishing = $this->publishing(array_values($pending), $frame);

        $chunkFrom = $from;
        for ($step = 0; $pending !== [] && $chunkFrom <= $to; $step++) {
            $length  = self::SCAN_CHUNKS[$step] ?? null;
            $chunkTo = $length === null ? $to : min($to, BookingFrame::addDays($chunkFrom, $length - 1));
            $days    = $frame->days($chunkFrom, $chunkTo);
            $start   = $days[0]['start'];
            $end     = $days[count($days) - 1]['end'];

            $schedules = $this->schedules(array_values($pending), $start, $end, $frame, $publishing);
            foreach (array_keys($pending) as $id) {
                $found = self::firstOpeningIn($schedules[$id], $days, $frame, $partOfDay);
                if ($found !== null) {
                    $out[$id] = $found;
                    unset($pending[$id]);
                }
            }
            $chunkFrom = BookingFrame::addDays($chunkTo, 1);
        }

        return $out;
    }

    /**
     * The first of $days (consecutive, in order) with an open time in
     * $partOfDay (any when null) — pure.
     *
     * @param list<array{date:string, start:int, end:int, h5:int, h12:int, h17:int}> $days
     * @return array{date:string, open_slots:int, first_at:int, slots:list<int>}|null
     */
    public static function firstOpeningIn(Schedule $schedule, array $days, BookingFrame $frame, ?string $partOfDay = null): ?array
    {
        if ($days === []) {
            return null;
        }
        $start   = $days[0]['start'];
        $end     = $days[count($days) - 1]['end'];
        $buckets = self::byDay(SlotGenerator::generate($schedule, $start, $end, $frame->bookableFrom, $frame->bookableUntil), $days);
        foreach ($days as $i => $day) {
            $open = [];
            foreach ($buckets[$i] ?? [] as $c) {
                if ($c['state'] === SlotGenerator::OPEN
                    && ($partOfDay === null || BookingFrame::partOf($day, $c['start']) === $partOfDay)
                ) {
                    $open[] = $c['start'];
                }
            }
            if ($open !== []) {
                return ['date' => $day['date'], 'open_slots' => count($open), 'first_at' => $open[0], 'slots' => $open];
            }
        }

        return null;
    }

    /**
     * Each doctor's open times per date for the dates $from … $to (clipped to
     * the bookable dates) — the suggestions' view of a few days. Dates without
     * an opening are left out.
     *
     * @param list<Specialist> $specialists
     * @return array<string, array<string, list<array{at:int, period:string}>>> id => date => times
     */
    public function openingsByDate(array $specialists, BookingFrame $frame, string $from, string $to): array
    {
        $out  = [];
        $live = [];
        foreach ($specialists as $s) {
            $out[$s->getId()] = [];
            if (self::isLive($s, $frame)) {
                $live[] = $s;
            }
        }
        $from = max($from, $frame->today);
        $to   = min($to, $frame->bookableUntilDate);
        if ($live === [] || $from > $to) {
            return $out;
        }
        $days      = $frame->days($from, $to);
        $start     = $days[0]['start'];
        $end       = $days[count($days) - 1]['end'];
        $schedules = $this->schedules($live, $start, $end, $frame);
        foreach ($live as $s) {
            $buckets = self::byDay(SlotGenerator::generate($schedules[$s->getId()], $start, $end, $frame->bookableFrom, $frame->bookableUntil), $days);
            foreach ($days as $i => $day) {
                foreach ($buckets[$i] ?? [] as $c) {
                    if ($c['state'] === SlotGenerator::OPEN) {
                        $out[$s->getId()][$day['date']][] = ['at' => $c['start'], 'period' => BookingFrame::partOf($day, $c['start'])];
                    }
                }
            }
        }

        return $out;
    }

    /**
     * The availability summary a directory card carries: the date it describes
     * (a filtered date's first matching opening, else the next opening), how
     * many times are open that date, the first, up to three to preview, and the
     * next opening at all.
     *
     * @param array{date:string, open_slots:int, first_at:int, slots:list<int>}|null $day
     * @param array{first_at:int}|null $next
     * @return array{date:?string, open_slots:int, first_slot_at:?string, slots_preview:list<string>, next_available_at:?string}
     */
    public static function summary(?array $day, ?array $next): array
    {
        return [
            'date'              => $day['date'] ?? null,
            'open_slots'        => $day['open_slots'] ?? 0,
            'first_slot_at'     => $day !== null ? BookingFrame::iso($day['first_at']) : null,
            'slots_preview'     => $day !== null ? array_map(BookingFrame::iso(...), array_slice($day['slots'], 0, 3)) : [],
            'next_available_at' => $next !== null ? BookingFrame::iso($next['first_at']) : null,
        ];
    }

    // ----- Legacy -----

    /**
     * The next $maxDays UTC days (of the 21 from today, inside the booking
     * window) that have an open time, with UTC labels — the `?days=N` form of
     * the slots endpoint, kept for older clients.
     *
     * @return list<array{date:string,weekday:string,day:string,slots:list<array{iso:string,label:string,time:string}>}>
     */
    public function availableDays(Specialist $specialist, int $maxDays = 7, ?DateTimeImmutable $now = null): array
    {
        if (!self::hasTimes($specialist)) {
            return [];
        }
        $utc      = new DateTimeZone('UTC');
        $frame    = $this->frame($utc, $now);
        $from     = intdiv($frame->now, self::DAY) * self::DAY;
        $to       = min($from + self::LEGACY_SCAN_DAYS * self::DAY, $frame->bookableUntil);
        $schedule = $this->schedules([$specialist], $from, $to, $frame)[$specialist->getId()];

        $byDay = [];
        foreach (SlotGenerator::generate($schedule, $from, $to, $frame->bookableFrom, $frame->bookableUntil) as $c) {
            if ($c['state'] !== SlotGenerator::OPEN) {
                continue;
            }
            $at = new DateTimeImmutable('@' . $c['start']);
            $byDay[$at->format('Y-m-d')][] = [
                'iso'   => $at->format(DATE_ATOM),
                'label' => $at->format('g:i A'),
                'time'  => $at->format('H:i'),
            ];
        }

        $days = [];
        foreach ($byDay as $date => $slots) {
            if (count($days) >= $maxDays) {
                break;
            }
            $d = new DateTimeImmutable($date, $utc);
            $days[] = ['date' => $date, 'weekday' => $d->format('D'), 'day' => $d->format('j'), 'slots' => $slots];
        }

        return $days;
    }

    // ----- Loading -----

    /**
     * Each specialist's {@see Schedule} for generating times in [$from, $to):
     * two queries for any number of doctors (slots + blocks, taken times), plus
     * one to see who publishes slots when a doctor has no weekly hours. The
     * windows reach a day either side so a block or booking that overlaps an
     * edge time still counts. `$ignoreAppointmentId`: an appointment being
     * moved, whose current time doesn't count as taken.
     *
     * @param list<Specialist> $specialists
     * @param array<string,true>|null $publishing precomputed {@see publishing()}
     * @return array<string, Schedule> by specialist id
     */
    public function schedules(
        array $specialists,
        int $from,
        int $to,
        BookingFrame $frame,
        ?array $publishing = null,
        ?string $ignoreAppointmentId = null,
    ): array {
        $out = [];
        $ids = [];
        foreach ($specialists as $s) {
            if (self::hasTimes($s)) {
                $ids[] = $s->getId();
            } else {
                $out[$s->getId()] = new Schedule($s->getSlotMinutes());
            }
        }
        if ($ids === []) {
            return $out;
        }
        $publishing ??= $this->publishing($specialists, $frame);

        $open   = [];
        $blocks = [];
        $rows   = $this->slots->rowsForSpecialistsBetween(
            $ids,
            self::db(intdiv($from, self::DAY) * self::DAY - self::DAY),
            self::db((intdiv($to - 1, self::DAY) + 2) * self::DAY),
        );
        foreach ($rows as $row) {
            $span = [self::ts($row['starts_at']), self::ts($row['ends_at'])];
            $kind = $row['kind'] instanceof SlotKind ? $row['kind'] : SlotKind::tryFrom((string) $row['kind']);
            if ($kind === SlotKind::OPEN) {
                $open[(string) $row['specialist_id']][] = $span;
            } elseif ($kind === SlotKind::BLOCK) {
                $blocks[(string) $row['specialist_id']][] = $span;
            }
        }

        $booked = [];
        $taken  = $this->appointments->takenStartsFor($ids, self::db($from - self::DAY), self::db($to + self::DAY), self::db($frame->now), $ignoreAppointmentId);
        foreach ($taken as $row) {
            $booked[(string) $row['specialist_id']][] = self::ts($row['scheduled_at']);
        }

        foreach ($specialists as $s) {
            $id = $s->getId();
            if (isset($out[$id])) {
                continue;
            }
            $out[$id] = new Schedule(
                $s->getSlotMinutes(),
                $this->weeklyHours($s, isset($publishing[$id])),
                $open[$id] ?? [],
                $blocks[$id] ?? [],
                $booked[$id] ?? [],
            );
        }

        return $out;
    }

    /**
     * Of these specialists, the ones without weekly hours who publish an open
     * slot in the patient booking window [now, now + horizon_days) — they get
     * no weekday default. Always the patient window, whatever the frame, so
     * the staff calendar and the booking guard agree with the patient calendar
     * on which hours are in play. Doctors with their own hours never need asking.
     *
     * @param list<Specialist> $specialists
     * @return array<string,true>
     */
    private function publishing(array $specialists, BookingFrame $frame): array
    {
        $ask = [];
        foreach ($specialists as $s) {
            if (self::hasTimes($s) && $s->getWeeklyHours() === null) {
                $ask[] = $s->getId();
            }
        }

        return $ask === []
            ? []
            : $this->slots->specialistIdsWithOpenSlots($ask, self::db($frame->now), self::db($frame->now + $this->horizonDays() * self::DAY));
    }

    /**
     * The recurring grid in play. The weekday default only stands in for an
     * approved doctor who never set hours and publishes no slots in the booking
     * window — a doctor still onboarding (or suspended) must never look bookable
     * on made-up hours.
     *
     * @return array<string, list<array{0:string,1:string}>>
     */
    private function weeklyHours(Specialist $specialist, bool $publishesSlots = false): array
    {
        $own = $specialist->getWeeklyHours();
        if ($own !== null) {
            return $own;
        }

        return $specialist->isApproved() && !$publishesSlots ? self::DEFAULT_HOURS : [];
    }

    /** Can this doctor have any times at all (approved — or legacy — and not removed)? */
    private static function hasTimes(Specialist $specialist): bool
    {
        return !$specialist->isDeleted() && $specialist->isApproved();
    }

    /**
     * Does this doctor show times in $frame: they have times, and are switched
     * on for bookings — unless it is a staff frame (staff and the doctor book
     * past the switch, as the booking guard lets them).
     */
    private static function isLive(Specialist $specialist, BookingFrame $frame): bool
    {
        return self::hasTimes($specialist) && (!$frame->enforceHorizon || $specialist->isAvailable());
    }

    /**
     * Sort generated candidates into $days (both in time order).
     *
     * @param list<array{start:int, end:int, state:string}> $candidates
     * @param list<array{start:int, end:int}> $days
     * @return array<int, list<array{start:int, end:int, state:string}>> by day index
     */
    private static function byDay(array $candidates, array $days): array
    {
        $out = [];
        $i   = 0;
        $n   = count($days);
        foreach ($candidates as $c) {
            while ($i < $n && $c['start'] >= $days[$i]['end']) {
                $i++;
            }
            if ($i >= $n) {
                break;
            }
            if ($c['start'] >= $days[$i]['start']) {
                $out[$i][] = $c;
            }
        }

        return $out;
    }

    /** An instant as Doctrine stores it: wall-clock in the process timezone. */
    private static function db(int $at): DateTimeImmutable
    {
        return (new DateTimeImmutable('@' . $at))->setTimezone(new DateTimeZone(date_default_timezone_get()));
    }

    /** A hydrated (process-timezone) date value as unix seconds. */
    private static function ts(mixed $value): int
    {
        return $value instanceof DateTimeInterface
            ? $value->getTimestamp()
            : (new DateTimeImmutable((string) $value, new DateTimeZone(date_default_timezone_get())))->getTimestamp();
    }
}
