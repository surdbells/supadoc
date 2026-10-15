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
 * POST /api/specialists/{id}/reject {reason} — send a submitted profile back to
 * the doctor with what to change (shown on their onboarding page and emailed;
 * kept in the doctor's history and the audit trail). They stay unlisted until
 * they resubmit and are approved. Needs `specialists.manage`.
 */
final class RejectSpecialistAction
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
        $body       = (array) $request->getParsedBody();
        $reason     = (string) ($body['reason'] ?? '');
        [$actorId, $actorName] = $this->reviewer($request, $this->users);

        // Throws ValidationException (→ 422) for a blank reason or a profile not in review.
        $this->onboarding->reject($specialist, $reason, $actorId, $actorName);
        $this->auditReview($request, $this->users, $this->audit, 'specialist.rejected', $specialist, ['reason' => trim($reason)]);

        return $this->success($response, $this->onboarding->summary($specialist, true), 'Sent back to the doctor');
    }
}
