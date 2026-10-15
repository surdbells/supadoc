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
 * POST /api/specialists/{id}/changes/reject {reason} — turn down the doctor's
 * requested profile changes, with a reason they see (in-app, by email, and on
 * their profile until they ask again). Nothing changes on the profile. 422 for
 * a blank reason or when nothing is waiting. Audited. Needs
 * `specialists.manage`.
 */
final class RejectSpecialistChangesAction
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
        $body       = (array) $request->getParsedBody();
        [$actorId, $actorName] = $this->reviewer($request, $this->users);

        $this->onboarding->rejectChanges($specialist, (string) ($body['reason'] ?? ''), $actorId, $actorName);

        return $this->success($response, $this->onboarding->summary($specialist, true), 'Changes turned down');
    }
}
