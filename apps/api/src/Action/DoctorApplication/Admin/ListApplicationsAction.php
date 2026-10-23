<?php

declare(strict_types=1);

namespace App\Action\DoctorApplication\Admin;

use App\Action\DoctorApplication\HandlesApplicationRequests;
use App\Infrastructure\Application\ApplicationReviewService;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/doctor-applications — the list: q, filter, route, sort, page,
 * per_page (≤ 50). Never drafts. Needs `specialists.manage`.
 */
final class ListApplicationsAction
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
        $page = $this->review->list($request->getQueryParams());

        return $this->paginated($response, $page['items'], $page['total'], $page['page'], $page['per_page']);
    }
}
