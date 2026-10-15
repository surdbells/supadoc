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
 * GET /api/specialists/{id}/onboarding — the back-office review panel: the
 * doctor's profile as submitted, the onboarding checklist, their documents
 * (reviewer view), the change request, terms, licence, review status, whether
 * they can be approved now (and why not) and login state. Needs
 * `specialists.manage`. GET /api/specialists/{id} carries the same and more.
 */
final class GetSpecialistOnboardingAction
{
    use ApiResponse;

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

        return $this->success($response, $this->onboarding->summary($specialist, true) + [
            'profile' => $specialist->toPrivateArray(),
            'login'   => $this->onboarding->loginArray($this->users->findBySpecialist($specialist->getId())),
        ]);
    }
}
