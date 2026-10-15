<?php

declare(strict_types=1);

namespace App\Action\Specialist;

use App\Domain\Entity\Specialist;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\DoctorOnboardingService;
use App\Infrastructure\Service\SpecialistSuspensionService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/specialists/{id}/reinstate {note} — lift a suspension: back to
 * approved, listed and bookable. Needs a verified, unexpired practising
 * licence (422 `practising_licence` otherwise) and a note (1–2000 chars).
 * Bookings cancelled by the suspension are not restored. The doctor is
 * emailed; audited. Needs `specialists.manage`.
 */
final class ReinstateSpecialistAction
{
    use ApiResponse;
    use AuditsSpecialistReview;

    public function __construct(
        private readonly SpecialistRepository $specialists,
        private readonly UserRepository $users,
        private readonly SpecialistSuspensionService $suspensions,
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

        $this->suspensions->reinstate($specialist, (string) ($body['note'] ?? ''), $actorId, $actorName);

        return $this->success($response, $this->onboarding->summary($specialist, true), 'Doctor reinstated');
    }
}
