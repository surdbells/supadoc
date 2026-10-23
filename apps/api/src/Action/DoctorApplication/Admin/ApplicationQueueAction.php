<?php

declare(strict_types=1);

namespace App\Action\DoctorApplication\Admin;

use App\Action\DoctorApplication\HandlesApplicationRequests;
use App\Infrastructure\Application\ApplicationReviewService;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/doctor-applications/queue — the nav badge (`needs_action`) and
 * the filter counts. Not cached. Needs `specialists.manage`.
 */
final class ApplicationQueueAction
{
    use ApiResponse;
    use HandlesApplicationRequests;

    public function __construct(
        private readonly ApplicationReviewService $review,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        return $this->success($response, $this->review->queue());
    }
}
