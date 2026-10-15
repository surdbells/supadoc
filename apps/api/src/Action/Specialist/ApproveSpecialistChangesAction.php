<?php

declare(strict_types=1);

namespace App\Action\Specialist;

use App\Domain\Entity\Specialist;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\DoctorOnboardingService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/specialists/{id}/changes/approve — approve the doctor's requested
 * changes to their locked profile fields: they go live (and print on new
 * prescriptions from now on), the approval snapshot is refreshed, the doctor
 * is told. 422 `changes` when nothing is waiting. Audited with before/after.
 * Needs `specialists.manage`.
 */
final class ApproveSpecialistChangesAction
{
    use ApiResponse;
    use AuditsSpecialistReview;

    public function __construct(
        private readonly SpecialistRepository $specialists,
        private readonly UserRepository $users,
        private readonly DoctorOnboardingService $onboarding,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
        array $args,
    ): ResponseInterface {
        /** @var Specialist $specialist */
        $specialist = $this->specialists->findOrFail((string) ($args['id'] ?? ''));
        [$actorId, $actorName] = $this->reviewer($request, $this->users);

        $this->onboarding->approveChanges($specialist, $actorId, $actorName);

        return $this->success($response, $this->onboarding->summary($specialist, true) + [
            'profile' => $specialist->toPrivateArray(),
        ], 'Changes approved');
    }
}
