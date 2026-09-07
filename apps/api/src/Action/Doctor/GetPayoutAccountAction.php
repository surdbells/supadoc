<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Domain\Repository\PayoutAccountRepository;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/** GET /api/doctor/payout-account — the doctor's saved payout beneficiary, or null. */
final class GetPayoutAccountAction
{
    use ApiResponse;
    use ResolvesDoctorSpecialist;

    public function __construct(
        private readonly UserRepository $users,
        private readonly SpecialistRepository $specialists,
        private readonly PayoutAccountRepository $accounts,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        $specialist = $this->doctorSpecialist($request, $this->users, $this->specialists);
        if ($specialist === null) {
            return $this->error($response, 'This account is not a doctor profile', 403);
        }

        $account = $this->accounts->forSpecialist($specialist->getId());

        return $this->success($response, $account?->toArray());
    }
}
