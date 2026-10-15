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
 * POST /api/specialists/{id}/approve {attest: true, note?} — approve a doctor's
 * submitted profile: they become listed and bookable, what was approved is
 * snapshotted, and they are emailed. 422 (every reason, by field) unless the
 * profile is in review with the checklist complete, the MDCN certificate and a
 * current practising licence verified, the terms in force accepted and the
 * reviewer attests. A suspended doctor is reinstated with POST .../reinstate.
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
        $body       = (array) $request->getParsedBody();
        $attested   = in_array($body['attest'] ?? null, [true, 1, '1', 'true'], true);
        $note       = isset($body['note']) ? trim((string) $body['note']) : null;
        if ($note !== null && mb_strlen($note) > DoctorOnboardingService::MAX_REASON) {
            return $this->error($response, 'Validation failed', 422, ['note' => 'Keep the note under 2000 characters']);
        }
        [$actorId, $actorName] = $this->reviewer($request, $this->users);

        // Throws ValidationException (→ 422) with every reason it can't be approved yet.
        $this->onboarding->approve($specialist, $actorId, $actorName, $attested, $note);
        $this->auditReview($request, $this->users, $this->audit, 'specialist.approved', $specialist, [
            'attested'       => true,
            'note'           => $note !== '' ? $note : null,
            'credential_ids' => $specialist->getApprovedSnapshot()['credential_ids'] ?? [],
        ]);

        return $this->success($response, $this->onboarding->summary($specialist, true), 'Doctor approved');
    }
}
