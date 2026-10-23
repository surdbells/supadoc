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
 * POST /api/doctor-applications/{id}/resend-interview — email + text the
 * interview details again. 429 resend_cooldown within 5 minutes. Needs
 * `specialists.manage`.
 */
final class ResendInterviewAction
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

        return $this->success($response, $this->review->resendInterview((string) ($args['id'] ?? ''), $actorId, $actorName), 'Interview details sent');
    }
}
