<?php

declare(strict_types=1);

namespace App\Action\DoctorApplication\Admin;

use App\Action\DoctorApplication\HandlesApplicationRequests;
use App\Infrastructure\Application\ApplicationReviewService;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/doctor-applications/{id} — the detail, its actions and the
 * approval preview. A draft is 404. Needs `specialists.manage`.
 */
final class GetApplicationAction
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
        array $args,
    ): ResponseInterface {
        return $this->success($response, $this->review->detail((string) ($args['id'] ?? '')));
    }
}
