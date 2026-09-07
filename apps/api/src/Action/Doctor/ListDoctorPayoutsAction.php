<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Domain\Entity\Payout;
use App\Domain\Repository\PayoutRepository;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/** GET /api/doctor/payouts — the doctor's payout request history. */
final class ListDoctorPayoutsAction
{
    use ApiResponse;
    use ResolvesDoctorSpecialist;

    public function __construct(
        private readonly UserRepository $users,
        private readonly SpecialistRepository $specialists,
        private readonly PayoutRepository $payouts,
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

        $rows = array_map(
            static fn (Payout $p): array => $p->toArray(),
            $this->payouts->forSpecialist($specialist->getId()),
        );

        return $this->success($response, $rows);
    }
}
