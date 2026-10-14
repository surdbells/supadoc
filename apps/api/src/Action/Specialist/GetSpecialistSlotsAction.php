<?php

declare(strict_types=1);

namespace App\Action\Specialist;

use App\Domain\Entity\Specialist;
use App\Domain\Exception\EntityNotFoundException;
use App\Domain\Repository\SpecialistRepository;
use App\Infrastructure\Service\AvailabilityService;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/portal/specialists/{id}/slots?days=N — the specialist's real open
 * consultation slots (schedule minus already-booked, minus past). Only approved
 * doctors have slots; one switched off for bookings has none.
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
        // findOrFail throws → 404 for an unknown specialist id.
        $id = (string) ($args['id'] ?? '');
        /** @var Specialist $specialist */
        $specialist = $this->specialists->findOrFail($id);
        // A doctor still onboarding (or removed) is as good as unknown here.
        if ($specialist->isDeleted() || !$specialist->isApproved()) {
            throw EntityNotFoundException::for(Specialist::class, $id);
        }
        // Switched off for bookings: no open times (pages that list them stay up).
        if (!$specialist->isAvailable()) {
            return $this->success($response, []);
        }

        $days = (int) ($request->getQueryParams()['days'] ?? 7);
        $days = max(1, min(14, $days));

        return $this->success(
            $response,
            $this->availability->availableDays($specialist, $days),
        );
    }
}
