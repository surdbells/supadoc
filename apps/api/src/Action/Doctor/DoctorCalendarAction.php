<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Availability\BookingFrame;
use App\Infrastructure\Availability\CalendarQuery;
use App\Infrastructure\Service\AvailabilityService;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/doctor/calendar?from=&to=&tz= — the signed-in doctor's own booking
 * calendar, for picking a time to reschedule to or propose a follow-up at:
 * the public calendar's shape and rules (AvailabilityRange), but not held to
 * the patient horizon (up to {@see AvailabilityService::STAFF_HORIZON_DAYS}
 * ahead, as their booking guard isn't) and shown while they are switched off
 * for bookings. Clinical: a suspended or unapproved doctor is refused by
 * DoctorStandingMiddleware.
 */
final class DoctorCalendarAction
{
    use ApiResponse;
    use ResolvesDoctorSpecialist;

    public function __construct(
        private readonly UserRepository $users,
        private readonly SpecialistRepository $specialists,
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

        $query = $request->getQueryParams();
        $frame = $this->availability->frame(BookingFrame::zone($query['tz'] ?? null), null, false);
        [$from, $to] = CalendarQuery::range($query, $frame);

        return $this->success($response, $this->availability->range($specialist, $from, $to, $frame));
    }
}
