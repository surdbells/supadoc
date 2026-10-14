<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\DoctorOnboardingService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/doctor/onboarding — the signed-in doctor's onboarding checklist
 * (photo, bio, qualifications, MDCN number, signature, availability, payout
 * account), review status and, when sent back, the admin's reason.
 */
final class GetDoctorOnboardingAction
{
    use ApiResponse;
    use ResolvesDoctorSpecialist;

    public function __construct(
        private readonly UserRepository $users,
        private readonly SpecialistRepository $specialists,
        private readonly DoctorOnboardingService $onboarding,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        $specialist = $this->doctorSpecialist($request, $this->users, $this->specialists);
        if ($specialist === null) {
            return $this->error($response, 'This account is not linked to a doctor profile. Please contact your administrator.', 403);
        }

        return $this->success($response, $this->onboarding->summary($specialist));
    }
}
