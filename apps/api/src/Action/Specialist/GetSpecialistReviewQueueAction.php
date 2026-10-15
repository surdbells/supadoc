<?php

declare(strict_types=1);

namespace App\Action\Specialist;

use App\Domain\Repository\SpecialistCredentialRepository;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Settings\ClinicTime;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/specialists/review-queue — what is waiting for a reviewer, for the
 * back office's badge: profiles in review, change requests, and documents
 * live doctors uploaded (a new licence, say). `total` is the three together;
 * licences expiring within 30 days / expired and doctors still owing their
 * documents are counted too (not in `total`). Counts only — no names. Needs
 * `specialists.manage`.
 */
final class GetSpecialistReviewQueueAction
{
    use ApiResponse;

    public function __construct(
        private readonly SpecialistRepository $specialists,
        private readonly SpecialistCredentialRepository $credentials,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        $today   = ClinicTime::today();
        $review  = $this->specialists->countPendingReview();
        $changes = $this->specialists->countAdminFilter('changes', $today);
        $docs    = $this->credentials->countPendingFromLiveDoctors();

        return $this->success($response, [
            'pending_review'       => $review,
            'pending_changes'      => $changes,
            'credentials_pending'  => $docs,
            'total'                => $review + $changes + $docs,
            'licences_expiring'    => $this->specialists->countAdminFilter('licence_expiring', $today),
            'licences_expired'     => $this->specialists->countAdminFilter('licence_expired', $today),
            'credentials_missing'  => $this->specialists->countAdminFilter('credentials_missing', $today),
        ]);
    }
}
