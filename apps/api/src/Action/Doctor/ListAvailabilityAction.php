<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Domain\Entity\Appointment;
use App\Domain\Entity\AvailabilitySlot;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\AvailabilitySlotRepository;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Domain\Settings\ProcessClock;
use App\Domain\Settings\TimeZones;
use App\Infrastructure\Availability\BookingFrame;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\AvailabilityService;
use DateTimeImmutable;
use DateTimeZone;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/doctor/availability?from=YYYY-MM-DD&to=YYYY-MM-DD&tz=IANA — the
 * doctor's own date-specific slots (open + blocked) across a window of local
 * days (at most 62), each tagged with its derived status, its `series_id` and
 * (blocks) whether it covers an `entire_day`. "Booked" is computed by matching
 * a live appointment to an open slot's start instant (so an appointment always
 * shows, even one booked from the recurring weekly grid before any explicit
 * slots existed).
 *
 * With `tz` (the doctor's profile zone; any other zone is a 409
 * `timezone_changed`) the days are local days and the response echoes `tz`
 * plus the regular weekly hours in play (`regular_hours`, `regular_hours_source`:
 * 'own' | 'default' | null). Without it, the legacy UTC days.
 */
final class ListAvailabilityAction
{
    use ApiResponse;
    use ResolvesDoctorSpecialist;
    use ReadsAvailabilityZone;

    private const MAX_DAYS = 62;

    public function __construct(
        private readonly UserRepository $users,
        private readonly SpecialistRepository $specialists,
        private readonly AvailabilitySlotRepository $slots,
        private readonly AppointmentRepository $appointments,
        private readonly AvailabilityService $availability,
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

        $params = $request->getQueryParams();
        $zoned  = $this->availabilityZone($response, $specialist, $params['tz'] ?? null);
        if ($zoned instanceof ResponseInterface) {
            return $zoned;
        }
        ['zone' => $tz, 'legacy' => $legacy] = $zoned;

        $today = (new DateTimeImmutable('now', $tz))->format('Y-m-d');
        $from  = self::ymd($params['from'] ?? null) ?? $today;
        $to    = self::ymd($params['to'] ?? null) ?? BookingFrame::addDays($from, 35);
        // Guard the window: [from, to] in local days, capped.
        if (BookingFrame::daysBetween($from, $to) < 0) {
            $to = $from;
        }
        if (BookingFrame::daysBetween($from, $to) >= self::MAX_DAYS) {
            $to = BookingFrame::addDays($from, self::MAX_DAYS - 1);
        }
        $fromAt = ProcessClock::normalize(new DateTimeImmutable('@' . TimeZones::localDayBounds($from, $tz)[0]));
        $toAt   = ProcessClock::normalize(new DateTimeImmutable('@' . TimeZones::localDayBounds($to, $tz)[1]));

        $slots       = $this->slots->forSpecialistBetween($specialist->getId(), $fromAt, $toAt);
        $appts       = $this->appointments->forSpecialistBetween($specialist->getId(), $fromAt, $toAt);
        $slotMinutes = $specialist->getSlotMinutes();

        // Index appointments by start instant for booked-status matching.
        $bookedAt = [];
        foreach ($appts as $a) {
            $bookedAt[$a->getScheduledAt()->getTimestamp()] = $a;
        }

        // Block ranges, for marking open slots that fall inside them.
        $blocks = array_filter($slots, static fn (AvailabilitySlot $s): bool => $s->isBlock());

        $rows       = [];
        $matchedApp = [];
        foreach ($slots as $slot) {
            $row = $slot->toArray() + ['entire_day' => false];
            if ($slot->isBlock()) {
                $row['status']     = 'blocked';
                $row['entire_day'] = self::isEntireDay($slot, $tz);
                $rows[]            = $row;
                continue;
            }

            $key = $slot->getStartsAt()->getTimestamp();
            if (isset($bookedAt[$key])) {
                $row['status']       = 'booked';
                $row['patient_name'] = $this->patientName($bookedAt[$key]);
                $matchedApp[$key]    = true;
            } elseif ($this->overlapsBlock($slot, $blocks)) {
                $row['status'] = 'blocked';
            } else {
                $row['status'] = 'open';
            }
            $rows[] = $row;
        }

        // Appointments with no matching explicit open slot (e.g. booked from the
        // recurring grid) — surface them as booked entries so nothing is hidden.
        $utc = new DateTimeZone('UTC');
        foreach ($appts as $a) {
            $key = $a->getScheduledAt()->getTimestamp();
            if (isset($matchedApp[$key])) {
                continue;
            }
            $start  = $a->getScheduledAt()->setTimezone($utc);
            $rows[] = [
                'id'           => 'appt-' . $a->getId(),
                'starts_at'    => $start->format(DATE_ATOM),
                'ends_at'      => $start->modify('+' . $slotMinutes . ' minutes')->format(DATE_ATOM),
                'kind'         => 'open',
                'reason'       => null,
                'series_id'    => null,
                'entire_day'   => false,
                'status'       => 'booked',
                'patient_name' => $this->patientName($a),
            ];
        }

        usort($rows, static fn (array $a, array $b): int => (new DateTimeImmutable((string) $a['starts_at']))->getTimestamp() <=> (new DateTimeImmutable((string) $b['starts_at']))->getTimestamp());

        $data = [
            'from'         => $from,
            'to'           => $to,
            'slot_minutes' => $slotMinutes,
            'slots'        => array_values($rows),
        ];
        if (!$legacy) {
            // Echoed only on the zone contract: a new editor enables Add and
            // Block once it sees `tz` (an older API never sends it).
            $regular = $this->availability->regularHours($specialist);
            $data += [
                'tz'                   => $tz->getName(),
                'regular_hours'        => $regular['hours'] !== null ? (object) $regular['hours'] : null,
                'regular_hours_source' => $regular['source'],
            ];
        }

        return $this->success($response, $data);
    }

    /** Does this block run from local midnight to the next local midnight of its start date? */
    private static function isEntireDay(AvailabilitySlot $slot, DateTimeZone $tz): bool
    {
        $start = $slot->getStartsAt()->getTimestamp();
        [$dayStart, $dayEnd] = TimeZones::localDayBounds(TimeZones::localDate($start, $tz), $tz);

        return $start === $dayStart && $slot->getEndsAt()->getTimestamp() === $dayEnd;
    }

    private function patientName(Appointment $a): string
    {
        $p = $a->getPatient()->toArray();

        return trim(((string) $p['first_name']) . ' ' . ((string) $p['last_name']));
    }

    /**
     * Does any block overlap this open slot's [start, end) span? Span-overlap
     * (not point membership) so a partial block still flags the open slot.
     *
     * @param array<int,AvailabilitySlot> $blocks
     */
    private function overlapsBlock(AvailabilitySlot $slot, array $blocks): bool
    {
        foreach ($blocks as $block) {
            if ($block->overlaps($slot->getStartsAt(), $slot->getEndsAt())) {
                return true;
            }
        }

        return false;
    }

    private static function ymd(mixed $value): ?string
    {
        return BookingFrame::isYmd($value) ? (string) $value : null;
    }
}
