<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Domain\Entity\Review;
use App\Domain\Repository\ReviewRepository;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/** GET /api/doctor/reviews — the doctor's reviews (paginated, newest first). */
final class DoctorReviewsAction
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

        $params = $this->getPaginationParams($request->getQueryParams());
        $page   = $this->reviews->paginatedForSpecialist($params['offset'], $params['per_page'], $specialist->getId());
        $items  = array_map(static fn (Review $r): array => $r->toArray(), $page['items']);

        return $this->paginated($response, $items, $page['total'], $params['page'], $params['per_page']);
    }
}
