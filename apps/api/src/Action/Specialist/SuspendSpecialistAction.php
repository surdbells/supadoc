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
 * POST /api/specialists/{id}/suspend {code, reason} — the doctor stopped
 * practising here (see SpecialistSuspensionService): unlisted, no clinical
 * work, signed out, every future booking cancelled and refunded (guest fees
 * included), open follow-up proposals withdrawn, each patient told after the
 * response. `code`: licence_expired | conduct | complaint | admin | other;
 * `reason` (1–2000 chars) is shown to the doctor. Calling it again for a
 * suspended doctor only finishes what is left (`incomplete` in a previous
 * answer). Audited. Needs `specialists.manage`.
 */
final class SuspendSpecialistAction
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

        // Throws ValidationException (→ 422) for an unknown code, a blank reason or a doctor still onboarding.
        $affected = $this->suspensions->suspend(
            $specialist,
            strtolower(trim((string) ($body['code'] ?? ''))),
            (string) ($body['reason'] ?? ''),
            $actorId,
            $actorName,
        );

        return $this->success(
            $response,
            ['summary' => $this->onboarding->summary($specialist, true), 'affected' => $affected],
            $affected['incomplete'] ? 'Doctor suspended, but some bookings could not be cancelled yet — suspend again to finish' : 'Doctor suspended',
        );
    }
}
