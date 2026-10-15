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
 * POST /api/specialists/{id}/credentials/{cid}/reject {reason} — a reviewer
 * turns a document down (waiting, or verified and found wrong) with a reason
 * the doctor sees; the doctor is told in-app and by email. Audited. Returns the
 * doctor's review summary. Needs `specialists.manage`.
 */
final class RejectSpecialistCredentialAction
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
        $body = (array) $request->getParsedBody();
        [$actorId, $actorName] = $this->reviewer($request, $this->users);

        // Throws ValidationException (→ 422) for a blank reason or a document already replaced.
        $this->service->reject($specialist, $credential, (string) ($body['reason'] ?? ''), $actorId, $actorName);

        return $this->success($response, $this->onboarding->summary($specialist, true), 'Document turned down');
    }
}
