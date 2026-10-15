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
 * GET /api/public/specialists/{id}/slots — the specialist's real open
 * consultation times (schedule minus booked, blocked and too-soon times).
 *
 *   ?date=YYYY-MM-DD&tz=Area/City — one day of the booking calendar:
 *     {date, tz, slots: [{iso, time, label, period}]}, times on `tz`'s clock
 *     (default: the clinic's zone). Empty outside today … bookable_until.
 *   ?days=N (legacy, 1–14) — the next N days that have open times, grouped by
 *     UTC date with UTC labels.
 *
 * Only approved doctors have slots (anyone else is a 404); one switched off for
 * bookings has none.
 */
final class GetSpecialistSlotsAction
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
        // A doctor still onboarding (or suspended, or removed) is as good as unknown here.
        if ($specialist === null || $specialist->isDeleted() || !$specialist->isApproved()) {
            throw EntityNotFoundException::for(Specialist::class, $id);
        }
        $query = $request->getQueryParams();

        if (array_key_exists('date', $query)) {
            $date  = CalendarQuery::date($query);
            $frame = $this->availability->frame(BookingFrame::zone($query['tz'] ?? null));

            return $this->success($response, $this->availability->daySlots($specialist, $date, $frame));
        }

        // Switched off for bookings: no open times (pages that list them stay up).
        if (!$specialist->isAvailable()) {
            return $this->success($response, []);
        }

        $days = (int) ($query['days'] ?? 7);
        $days = max(1, min(14, $days));

        return $this->success(
            $response,
            $this->availability->availableDays($specialist, $days),
        );
    }
}
