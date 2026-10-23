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
 * POST /api/doctor-applications/{id}/request-info — ask the applicant for
 * sections / documents with a message (cancels a scheduled interview). Needs
 * `specialists.manage`.
 */
final class RequestInfoAction
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

        return $this->success($response, $this->review->requestInfo((string) ($args['id'] ?? ''), $this->body($request), $actorId, $actorName), 'Request sent');
    }
}
