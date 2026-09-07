<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Domain\Repository\ReviewRepository;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/** GET /api/doctor/reviews/summary — average, count and 1–5 star distribution. */
final class DoctorReviewsSummaryAction
{
    use ApiResponse;
    use ResolvesDoctorSpecialist;

    public function __construct(
        private readonly UserRepository $users,
        private readonly SpecialistRepository $specialists,
        private readonly ReviewRepository $reviews,
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

        return $this->success($response, $this->reviews->summaryForSpecialist($specialist->getId()));
    }
}
