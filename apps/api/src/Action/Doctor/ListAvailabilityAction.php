<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Domain\Entity\Appointment;
use App\Domain\Entity\AvailabilitySlot;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\AvailabilitySlotRepository;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use DateTimeImmutable;
use DateTimeZone;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/doctor/availability?from=YYYY-MM-DD&to=YYYY-MM-DD — the doctor's own
 * date-specific slots (open + blocked) across a window, each tagged with its
 * derived status. "Booked" is computed by matching a live appointment to an
 * open slot's start (so an appointment always shows, even one booked from the
 * recurring weekly grid before any explicit slots existed).
 */
final class ListAvailabilityAction
{
    use ApiResponse;
    use ResolvesDoctorSpecialist;

    private const MAX_DAYS = 62;

    public function __construct(
        private readonly UserRepository $users,
        private readonly SpecialistRepository $specialists,
        private readonly AvailabilitySlotRepository $slots,
        private readonly AppointmentRepository $appointments,
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

        $tz     = new DateTimeZone('UTC');
        $params = $request->getQueryParams();
        $from   = $this->parseDate((string) ($params['from'] ?? ''), $tz)
            ?? (new DateTimeImmutable('today', $tz));
        $to     = $this->parseDate((string) ($params['to'] ?? ''), $tz)
            ?? $from->modify('+35 days');
        // Guard the window: [from, to) at day boundaries, capped.
        $from = $from->setTime(0, 0);
        $to   = $to->setTime(0, 0)->modify('+1 day');
        if ($to <= $from) {
            $to = $from->modify('+1 day');
        }
        if ($to > $from->modify('+' . self::MAX_DAYS . ' days')) {
            $to = $from->modify('+' . self::MAX_DAYS . ' days');
        }

        $slots  = $this->slots->forSpecialistBetween($specialist->getId(), $from, $to);
        $appts  = $this->appointments->forSpecialistBetween($specialist->getId(), $from, $to);
        $slotMinutes = $specialist->getSlotMinutes();

        // Index appointments by start "Y-m-d H:i" for booked-status matching.
        $bookedAt = [];
        foreach ($appts as $a) {
            $key            = $a->getScheduledAt()->setTimezone($tz)->format('Y-m-d H:i');
            $bookedAt[$key] = $a;
        }

        // Block ranges, for marking open slots that fall inside them.
        $blocks = array_filter($slots, static fn (AvailabilitySlot $s): bool => $s->isBlock());

        $rows       = [];
        $matchedApp = [];
        foreach ($slots as $slot) {
            $row = $slot->toArray();
            if ($slot->isBlock()) {
                $row['status'] = 'blocked';
                $rows[]        = $row;
                continue;
            }

            $key = $slot->getStartsAt()->setTimezone($tz)->format('Y-m-d H:i');
            if (isset($bookedAt[$key])) {
                $row['status']        = 'booked';
                $row['patient_name']  = $this->patientName($bookedAt[$key]);
                $matchedApp[$key]     = true;
            } elseif ($this->withinBlock($slot->getStartsAt(), $blocks)) {
                $row['status'] = 'blocked';
            } else {
                $row['status'] = 'open';
            }
            $rows[] = $row;
        }

        // Appointments with no matching explicit open slot (e.g. booked from the
        // recurring grid) — surface them as booked entries so nothing is hidden.
        foreach ($appts as $a) {
            $start = $a->getScheduledAt()->setTimezone($tz);
            $key   = $start->format('Y-m-d H:i');
            if (isset($matchedApp[$key])) {
                continue;
            }
            $rows[] = [
                'id'           => 'appt-' . $a->getId(),
                'starts_at'    => $start->format(DATE_ATOM),
                'ends_at'      => $start->modify('+' . $slotMinutes . ' minutes')->format(DATE_ATOM),
                'kind'         => 'open',
                'reason'       => null,
                'status'       => 'booked',
                'patient_name' => $this->patientName($a),
            ];
        }

        usort($rows, static fn (array $a, array $b): int => strcmp($a['starts_at'], $b['starts_at']));

        return $this->success($response, [
            'from'         => $from->format('Y-m-d'),
            'to'           => $to->modify('-1 day')->format('Y-m-d'),
            'slot_minutes' => $slotMinutes,
            'slots'        => array_values($rows),
        ]);
    }

    private function patientName(Appointment $a): string
    {
        $p = $a->getPatient()->toArray();

        return trim(((string) $p['first_name']) . ' ' . ((string) $p['last_name']));
    }

    /** @param array<int,AvailabilitySlot> $blocks */
    private function withinBlock(DateTimeImmutable $when, array $blocks): bool
    {
        foreach ($blocks as $block) {
            if ($block->covers($when)) {
                return true;
            }
        }

        return false;
    }

    private function parseDate(string $value, DateTimeZone $tz): ?DateTimeImmutable
    {
        if ($value === '') {
            return null;
        }
        $d = DateTimeImmutable::createFromFormat('!Y-m-d', $value, $tz);

        return $d !== false && $d->format('Y-m-d') === $value ? $d : null;
    }
}
