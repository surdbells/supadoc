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
 * GET /api/specialists/{id}/availability?from=&to=&tz= — the booking calendar
 * for staff booking on a patient's behalf (appointments.create or
 * appointments.book): the public calendar's shape and rules
 * ({@see GetSpecialistAvailabilityAction}), but not held to the patient
 * horizon — the window reaches {@see AvailabilityService::STAFF_HORIZON_DAYS}
 * ahead, as the staff booking guard does — and a doctor switched off for
 * bookings still shows their times. A doctor who can't practise shows none.
 */
final class GetStaffSpecialistAvailabilityAction
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
        $frame = $this->availability->frame(BookingFrame::zone($query['tz'] ?? null), null, false);
        [$from, $to] = CalendarQuery::range($query, $frame);

        return $this->success($response, $this->availability->range($specialist, $from, $to, $frame));
    }
}
