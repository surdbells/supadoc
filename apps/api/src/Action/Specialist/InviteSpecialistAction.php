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
 * POST /api/specialists/{id}/invite — email the doctor a one-time link (valid 7
 * days) to set their password, creating or linking their doctor login first. The
 * login has no usable password until they choose one. Calling it again resends:
 * the earlier link stops working. Needs `specialists.manage`.
 */
final class InviteSpecialistAction
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

        // Throws ValidationException (→ 422) for a missing email or a login clash.
        $result = $this->onboarding->invite($specialist);
        $this->auditReview($request, $this->users, $this->audit, 'specialist.invited', $specialist);

        return $this->success(
            $response,
            $result,
            $result['email_sent'] ? 'Invite sent' : 'Invite link created, but the email could not be sent',
        );
    }
}
