<?php

declare(strict_types=1);

namespace App\Action\Specialist;

use App\Domain\Entity\Specialist;
use App\Domain\Enum\AppointmentStatus;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\PayoutAccountRepository;
use App\Domain\Repository\ReviewRepository;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\DoctorOnboardingService;
use App\Infrastructure\Service\EarningsService;
use DateTimeImmutable;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/specialists/{id} — the back office's doctor page: the review state
 * and checklist, documents (reviewer view), change request against the
 * approved snapshot, terms, licence, suspension, standing, whether they can be
 * approved now, the full profile (incl. contact details), login state, the
 * payout account (account numbers masked) and headline stats (appointments by
 * status, upcoming, earnings, rating). Needs `specialists.manage`.
 */
final class GetSpecialistAdminAction
{
    use ApiResponse;
    use MasksPayoutAccounts;

    public function __construct(
        private readonly SpecialistRepository $specialists,
        private readonly UserRepository $users,
        private readonly DoctorOnboardingService $onboarding,
        private readonly AppointmentRepository $appointments,
        private readonly PayoutAccountRepository $payoutAccounts,
        private readonly ReviewRepository $reviews,
        private readonly EarningsService $earnings,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
        array $args,
    ): ResponseInterface {
        /** @var Specialist $specialist */
        $specialist = $this->specialists->findOrFail((string) ($args['id'] ?? ''));
        $id         = $specialist->getId();

        $byStatus = [];
        foreach (AppointmentStatus::cases() as $status) {
            $byStatus[$status->value] = $this->appointments->countForSpecialist($id, [$status]);
        }

        return $this->success($response, $this->onboarding->summary($specialist, true) + [
            'profile'        => $specialist->toPrivateArray(),
            'login'          => $this->onboarding->loginArray($this->users->findBySpecialist($id)),
            'payout_account' => self::maskAccount($this->payoutAccounts->forSpecialist($id)?->toArray()),
            'stats'          => [
                'appointments_by_status' => $byStatus,
                'upcoming'               => $this->appointments->countForSpecialist(
                    $id,
                    [AppointmentStatus::PENDING, AppointmentStatus::CONFIRMED, AppointmentStatus::RESCHEDULED],
                    new DateTimeImmutable(),
                ),
                'earnings'               => $this->earnings->summary($id),
                'reviews'                => $this->reviews->summaryForSpecialist($id),
            ],
        ]);
    }
}
