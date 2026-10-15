<?php

declare(strict_types=1);

namespace App\Action\Specialist;

use App\Domain\Entity\Specialist;
use App\Domain\Exception\EntityNotFoundException;
use App\Domain\Repository\SpecialistRepository;
use App\Infrastructure\Availability\BookingFrame;
use App\Infrastructure\Availability\CalendarQuery;
use App\Infrastructure\Service\AvailabilityService;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Ramsey\Uuid\Uuid;

/**
 * GET /api/specialists/{id}/slots?date=YYYY-MM-DD&tz= — one day's open times
 * for staff booking on a patient's behalf (appointments.create or
 * appointments.book): DaySlots like the public endpoint, but not held to the
 * patient horizon (up to {@see AvailabilityService::STAFF_HORIZON_DAYS} ahead)
 * and shown for a doctor switched off for bookings too.
 */
final class GetStaffSpecialistSlotsAction
{
    use ApiResponse;

    public function __construct(
        private readonly SpecialistRepository $specialists,
        private readonly AvailabilityService $availability,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
        array $args,
    ): ResponseInterface {
        $id = (string) ($args['id'] ?? '');
        /** @var Specialist|null $specialist */
        $specialist = Uuid::isValid($id) ? $this->specialists->find($id) : null;
        if ($specialist === null || $specialist->isDeleted()) {
            throw EntityNotFoundException::for(Specialist::class, $id);
        }

        $query = $request->getQueryParams();
        $date  = CalendarQuery::date($query);
        $frame = $this->availability->frame(BookingFrame::zone($query['tz'] ?? null), null, false);

        return $this->success($response, $this->availability->daySlots($specialist, $date, $frame));
    }
}
