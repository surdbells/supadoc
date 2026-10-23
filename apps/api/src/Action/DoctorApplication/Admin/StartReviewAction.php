<?php

declare(strict_types=1);

namespace App\Action\DoctorApplication\Admin;

use App\Action\DoctorApplication\HandlesApplicationRequests;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Application\ApplicationReviewService;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/doctor-applications/{id}/start-review — start (or resume) the
 * review. 409 status_changed | not_allowed. Needs `specialists.manage`.
 */
final class StartReviewAction
{
    use ApiResponse;
    use HandlesApplicationRequests;

    public function __construct(
        private readonly ApplicationReviewService $review,
        private readonly UserRepository $users,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
        array $args,
    ): ResponseInterface {
        [$actorId, $actorName] = $this->reviewer($request, $this->users);

        return $this->success($response, $this->review->startReview((string) ($args['id'] ?? ''), $this->body($request), $actorId, $actorName), 'Review started');
    }
}
