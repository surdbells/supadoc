<?php

declare(strict_types=1);

namespace App\Action\Specialist;

use App\Domain\Repository\SpecialistRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/specialists/review-queue — how many doctors have submitted their
 * profile and are waiting for review, for the back office's "Needs review"
 * badge. A count only — no names. Needs `specialists.manage`.
 */
final class GetSpecialistReviewQueueAction
{
    use ApiResponse;

    public function __construct(private readonly SpecialistRepository $specialists)
    {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        return $this->success($response, ['pending_review' => $this->specialists->countPendingReview()]);
    }
}
