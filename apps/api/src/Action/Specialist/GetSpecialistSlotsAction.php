<?php

declare(strict_types=1);

namespace App\Action\Specialist;

use App\Domain\Entity\Specialist;
use App\Domain\Repository\SpecialistRepository;
use App\Infrastructure\Service\AvailabilityService;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/portal/specialists/{id}/slots?days=N — the specialist's real open
 * consultation slots (schedule minus already-booked, minus past).
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
        /** @var Specialist $specialist */
        $specialist = $this->specialists->findOrFail((string) ($args['id'] ?? ''));

        $days = (int) ($request->getQueryParams()['days'] ?? 7);
        $days = max(1, min(14, $days));

        return $this->success(
            $response,
            $this->availability->availableDays($specialist, $days),
        );
    }
}
