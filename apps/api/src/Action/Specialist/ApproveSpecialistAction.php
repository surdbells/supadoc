<?php

declare(strict_types=1);

namespace App\Action\Specialist;

use App\Domain\Entity\Specialist;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\AuditLogger;
use App\Infrastructure\Service\DoctorOnboardingService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/specialists/{id}/approve — approve a doctor's submitted profile (or
 * reinstate a suspended one): they become listed and bookable, and are emailed.
 * Needs `specialists.manage`.
 */
final class ApproveSpecialistAction
{
    use ApiResponse;
    use AuditsSpecialistReview;

    public function __construct(
        private readonly SpecialistRepository $specialists,
        private readonly UserRepository $users,
        private readonly DoctorOnboardingService $onboarding,
        private readonly AuditLogger $audit,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
        array $args,
    ): ResponseInterface {
        /** @var Specialist $specialist */
        $specialist = $this->specialists->findOrFail((string) ($args['id'] ?? ''));

        // Throws ValidationException (→ 422) unless the profile is waiting for review.
        $this->onboarding->approve($specialist, (string) $request->getAttribute('user_id'));
        $this->auditReview($request, $this->users, $this->audit, 'specialist.approved', $specialist);

        return $this->success($response, $this->onboarding->summary($specialist), 'Doctor approved');
    }
}
