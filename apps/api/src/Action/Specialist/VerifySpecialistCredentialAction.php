<?php

declare(strict_types=1);

namespace App\Action\Specialist;

use App\Domain\Entity\Specialist;
use App\Domain\Repository\SpecialistCredentialRepository;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\DoctorCredentialService;
use App\Infrastructure\Service\DoctorOnboardingService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/specialists/{id}/credentials/{cid}/verify {register_checked: true,
 * register_reference, note?, expires_at?, number?} — a reviewer verifies a
 * document waiting for review, attesting that they checked it against the
 * MDCN register. A licence must end up with an unexpired expiry date (the
 * uploaded one, or `expires_at` correcting it). It replaces the doctor's older
 * verified document of the same kind. Audited. Returns the doctor's review
 * summary. Needs `specialists.manage`.
 */
final class VerifySpecialistCredentialAction
{
    use ApiResponse;
    use AuditsSpecialistReview;

    public function __construct(
        private readonly SpecialistRepository $specialists,
        private readonly SpecialistCredentialRepository $credentials,
        private readonly DoctorCredentialService $service,
        private readonly DoctorOnboardingService $onboarding,
        private readonly UserRepository $users,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
        array $args,
    ): ResponseInterface {
        /** @var Specialist $specialist */
        $specialist = $this->specialists->findOrFail((string) ($args['id'] ?? ''));
        $credential = $this->credentials->findForSpecialist((string) ($args['cid'] ?? ''), $specialist->getId());
        if ($credential === null) {
            return $this->error($response, 'Document not found', 404);
        }
        [$actorId, $actorName] = $this->reviewer($request, $this->users);

        // Throws ValidationException (→ 422) without the attestation, or for an expired / already-reviewed document.
        $this->service->verify($specialist, $credential, (array) $request->getParsedBody(), $actorId, $actorName);

        return $this->success($response, $this->onboarding->summary($specialist, true), 'Document verified');
    }
}
