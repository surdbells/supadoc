<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Domain\Entity\AvailabilitySlot;
use App\Domain\Enum\SlotKind;
use App\Domain\Repository\AvailabilitySlotRepository;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Domain\Settings\ProcessClock;
use App\Domain\Settings\ScheduleRules;
use App\Domain\Settings\TimeZones;
use App\Infrastructure\Availability\AvailabilitySeries;
use App\Infrastructure\Availability\AvailabilitySeriesException;
use App\Infrastructure\Availability\BookingFrame;
use App\Infrastructure\Availability\SpanIndex;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\AvailabilityService;
use App\Infrastructure\Service\SlotLock;
use DateTimeImmutable;
use Doctrine\ORM\EntityManagerInterface;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Ramsey\Uuid\Uuid;

/**
 * POST /api/doctor/availability — publish open times. The [start, end) range
 * on `date` is cut into `duration`-minute times; `repeat` adds them every day
 * ('daily'), on the start date's weekday ('weekly') or on chosen weekdays
 * ('days', 0=Sun … 6=Sat) for `weeks` weeks (1–26). Rows of one repeating
 * request share a `series_id`.
 *
 * Times are wall clock in `tz` (the doctor's profile zone — any other zone is
 * a 409 `timezone_changed`); `end` may be "24:00" (midnight). Without `tz` the
 * legacy contract holds: UTC wall clock, `recurring: true` meaning weekly.
 *
 * A time whose start an OPEN row already has is `existing`; one overlapping an
 * OPEN row is skipped as `overlapping`; one on a block is still made (the
 * block overlays it) and counted `blocked`. Re-posting a request is therefore
 * idempotent. A repeating request drops times already gone today (`past`).
 * Writes run under the doctor's slot lock (the one every booking takes), and
 * nothing goes beyond 365 days or 4,000 times at once.
 *
 * Body: { date: "YYYY-MM-DD", start: "HH:MM", end: "HH:MM"|"24:00",
 *         duration: 15|30|45|60, tz?: IANA, repeat?: none|daily|weekly|days,
 *         days?: int[], weeks?: int, recurring?: bool (legacy) }
 */
final class AddAvailabilityAction
{
    use ApiResponse;
    use ResolvesDoctorSpecialist;
    use ReadsAvailabilityZone;

    private const FLUSH_EVERY = 500;

    public function __construct(
        private readonly UserRepository $users,
        private readonly SpecialistRepository $specialists,
        private readonly AvailabilitySlotRepository $slots,
        private readonly EntityManagerInterface $em,
        private readonly SlotLock $slotLock,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        $specialist = $this->doctorSpecialist($request, $this->users, $this->specialists);
        if ($specialist === null) {
            return $this->error($response, 'This account is not a doctor profile', 403);
        }

        $body = (array) $request->getParsedBody();
        $zoned = $this->availabilityZone($response, $specialist, $body['tz'] ?? null);
        if ($zoned instanceof ResponseInterface) {
            return $zoned;
        }
        ['zone' => $tz, 'legacy' => $legacy] = $zoned;
        $now = new DateTimeImmutable();

        $date = trim((string) ($body['date'] ?? ''));
        if (!BookingFrame::isYmd($date)) {
            return $this->error($response, 'Validation failed', 422, ['date' => 'Enter a valid date']);
        }
        $options = AvailabilitySeries::options($body);
        if ($options['errors'] !== []) {
            return $this->error($response, 'Validation failed', 422, $options['errors']);
        }
        ['repeat' => $repeat, 'weeks' => $weeks, 'days' => $days] = $options;

        if (ScheduleRules::isPastLocalDay($date, $tz, $now)) {
            return $this->error($response, 'Validation failed', 422, ['date' => 'Choose today or a later date']);
        }
        $limit = BookingFrame::addDays($now->setTimezone($tz)->format('Y-m-d'), AvailabilityService::STAFF_HORIZON_DAYS);
        if (BookingFrame::daysBetween($date, $limit) < 0) {
            return $this->error($response, 'Validation failed', 422, ['date' => 'Choose a date within the next 12 months']);
        }

        $start    = self::startMinutes($body['start'] ?? null);
        $end      = self::endMinutes($body['end'] ?? null, !$legacy);
        $duration = (int) ($body['duration'] ?? 30);

        $errors = [];
        if ($start === null) {
            $errors['start'] = 'Enter a start time';
        }
        if ($end === null) {
            $errors['end'] = 'Enter an end time';
        }
        if ($start !== null && $end !== null && $end <= $start) {
            $errors['end'] = 'End time must be after the start time';
        }
        if (!in_array($duration, [15, 30, 45, 60], true)) {
            $errors['duration'] = 'Choose 15, 30, 45 or 60 minutes';
        } elseif (
            $start !== null && $end !== null && $end > $start
            && ScheduleRules::slotsInRange($start, $end, $duration) === 0
        ) {
            // Otherwise this "succeeds" with 0 slots and reads like a duplicate.
            $errors['end'] = 'The time range must fit at least one ' . $duration . '-minute slot';
        }
        if ($errors !== []) {
            return $this->error($response, 'Validation failed', 422, $errors);
        }
        /** @var int $start */
        /** @var int $end */

        $weekdays = AvailabilitySeries::weekdaysFor($repeat, $date, $days);
        try {
            $candidates = AvailabilitySeries::expand($date, $start, $end, $duration, $weekdays, $repeat === 'none' ? 1 : $weeks, $tz);
        } catch (AvailabilitySeriesException $e) {
            // One day with no time in it: its range lies in a spring-forward gap
            // (02:00–03:00 doesn't exist that night) — say so about the range.
            if ($repeat === 'none' && $e->field === 'date') {
                return $this->error($response, 'Validation failed', 422, [
                    'end' => 'The time range must fit at least one ' . $duration . '-minute slot',
                ]);
            }

            return $this->error($response, 'Validation failed', 422, [$e->field => $e->getMessage()]);
        }
        $lastAt = $candidates[count($candidates) - 1][0];
        if (BookingFrame::daysBetween(TimeZones::localDate($lastAt, $tz), $limit) < 0) {
            return $this->error($response, 'Validation failed', 422, ['date' => 'Choose a date within the next 12 months']);
        }

        // Times already gone: a one-time request is refused (as always); a
        // repeating one starting today just skips them.
        $past = 0;
        if ($repeat === 'none') {
            if (ScheduleRules::hasPassed(new DateTimeImmutable('@' . $candidates[0][0]), $now)) {
                return $this->error($response, 'Validation failed', 422, [
                    'start' => 'That start time has already passed — choose a later time',
                ]);
            }
        } else {
            [$kept, $past] = AvailabilitySeries::dropPast($candidates, $now);
            if ($kept === []) {
                return $this->error($response, 'Validation failed', 422, [
                    'start' => 'That start time has already passed — choose a later time',
                ]);
            }
            $candidates = $kept;
        }

        $seriesId = $repeat !== 'none' ? Uuid::uuid4()->toString() : null;
        $lastYmd  = AvailabilitySeries::lastDate($date, $repeat, $weeks);
        $result   = $this->em->wrapInTransaction(function () use ($specialist, $candidates, $seriesId, $date, $lastYmd, $tz, $legacy): array {
            // The slot lock every booking takes, before anything is read.
            $this->slotLock->lockDoctor($specialist->getId());
            // The times were worked out in `tz`: a zone change that committed
            // while this waited for the lock makes them wrong — write nothing.
            if (!$legacy && !$this->zoneStillCurrent($this->em, $specialist, $tz)) {
                return ['error' => 'timezone_changed'];
            }

            // From a day early, so a row running past the first midnight counts too.
            $from   = ProcessClock::normalize(new DateTimeImmutable('@' . (TimeZones::localDayBounds($date, $tz)[0] - 86400)));
            $to     = ProcessClock::normalize(new DateTimeImmutable('@' . TimeZones::localDayBounds($lastYmd, $tz)[1]));
            $open   = [];
            $starts = [];
            $blocks = [];
            foreach ($this->slots->forSpecialistBetween($specialist->getId(), $from, $to) as $row) {
                $span = [$row->getStartsAt()->getTimestamp(), $row->getEndsAt()->getTimestamp()];
                if ($row->isOpen()) {
                    $open[]           = $span;
                    $starts[$span[0]] = true;
                } elseif ($row->isBlock()) {
                    $blocks[] = $span;
                }
            }

            $open    = SpanIndex::of($open);
            $blocks  = SpanIndex::of($blocks);
            $counts  = ['created' => 0, 'existing' => 0, 'overlapping' => 0, 'blocked' => 0];
            $created = [];
            foreach ($candidates as [$at, $until]) {
                if (isset($starts[$at])) {
                    $counts['existing']++;
                    continue;
                }
                // Candidates ascend and never overlap each other, so only the rows
                // that were already there need checking.
                if ($open->overlaps($at, $until)) {
                    $counts['overlapping']++;
                    continue;
                }
                $this->slots->persist(new AvailabilitySlot(
                    $specialist,
                    new DateTimeImmutable('@' . $at),
                    new DateTimeImmutable('@' . $until),
                    SlotKind::OPEN,
                    null,
                    $seriesId,
                ));
                $created[] = $at;
                $counts['created']++;
                if ($blocks->overlaps($at, $until)) {
                    $counts['blocked']++;
                }
                if ($counts['created'] % self::FLUSH_EVERY === 0) {
                    $this->em->flush();
                }
            }
            $this->em->flush();

            return $counts + ['first' => $created[0] ?? null, 'last' => $created !== [] ? $created[count($created) - 1] : null];
        });
        if (($result['error'] ?? null) === 'timezone_changed') {
            return $this->zoneChanged($response, $specialist);
        }

        $n = $result['created'];

        return $this->success($response, [
            'created'     => $n,
            'existing'    => $result['existing'],
            'overlapping' => $result['overlapping'],
            'past'        => $past,
            'blocked'     => $result['blocked'],
            'series_id'   => $n > 0 ? $seriesId : null,
            'first_at'    => $result['first'] !== null ? BookingFrame::iso($result['first']) : null,
            'last_at'     => $result['last'] !== null ? BookingFrame::iso($result['last']) : null,
            'tz'          => $tz->getName(),
            'repeat'      => $repeat,
        ], $n === 1 ? '1 time added' : $n . ' times added');
    }
}
