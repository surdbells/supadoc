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
 * GET /api/doctor/calendar/slots?date=YYYY-MM-DD&tz= — the signed-in doctor's
 * own open times on one date (DaySlots), not held to the patient horizon and
 * shown while they are switched off for bookings — what their reschedule and
 * follow-up proposals may use.
 */
final class DoctorCalendarSlotsAction
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
        $date  = CalendarQuery::date($query);
        $frame = $this->availability->frame(BookingFrame::zone($query['tz'] ?? null), null, false);

        return $this->success($response, $this->availability->daySlots($specialist, $date, $frame));
    }
}
