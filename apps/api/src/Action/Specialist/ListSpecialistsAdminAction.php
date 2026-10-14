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
 * GET /api/specialists — the back-office specialist list. Staff-scoped and gated
 * on `specialists.manage`. Unlike the public/portal directories, this includes
 * every specialist whatever their onboarding status, each one's (otherwise
 * server-side) contact email, review status and doctor-login state, so an
 * operator can invite, review and fix them. Ordered by name; the set is small,
 * so it's returned unpaginated.
 */
final class ListSpecialistsAdminAction
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
    ): ResponseInterface {
        $page   = $this->specialists->paginated(0, 500, 'name', 'asc', approvedOnly: false);
        $logins = $this->users->findBySpecialistIds(array_map(
            static fn (Specialist $s): string => $s->getId(),
            $page['items'],
        ));

        $rows = array_map(
            fn (Specialist $s): array => $s->toArray()
                + ['email' => $s->getEmail()]
                + $s->toReviewArray()
                + ['login' => $this->onboarding->loginArray($logins[$s->getId()] ?? null)],
            $page['items'],
        );

        return $this->success($response, $rows);
    }
}
