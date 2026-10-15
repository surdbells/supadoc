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
 * GET /api/public/specialists/{id}/availability?from=YYYY-MM-DD&to=YYYY-MM-DD&tz=Area/City
 * — the booking calendar's month: one status per date (available / few /
 * full / closed / blocked / past / beyond) with its open count and first time,
 * the bookable window and the next opening anywhere in it. Dates are `tz`'s
 * calendar days (default: the clinic's zone; an unknown zone falls back to
 * it). At most 42 days (a 6-week grid), starting between 42 days before today
 * and bookable_until ({@see CalendarQuery}); `from` defaults to today and `to`
 * to from + 41 days. Public; never block reasons or booked counts. Staff and
 * the doctor have their own, unheld by the patient horizon
 * ({@see GetStaffSpecialistAvailabilityAction}, DoctorCalendarAction).
 */
final class GetSpecialistAvailabilityAction
{
    use ApiResponse;

    /** A 6-week month grid. */
    public const MAX_DAYS = CalendarQuery::MAX_DAYS;

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
        // A doctor still onboarding (or suspended, or removed) is as good as unknown here.
        if ($specialist === null || $specialist->isDeleted() || !$specialist->isApproved()) {
            throw EntityNotFoundException::for(Specialist::class, $id);
        }

        $query = $request->getQueryParams();
        $frame = $this->availability->frame(BookingFrame::zone($query['tz'] ?? null));
        [$from, $to] = CalendarQuery::range($query, $frame);

        return $this->success($response, $this->availability->range($specialist, $from, $to, $frame));
    }
}
