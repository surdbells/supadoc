<?php

declare(strict_types=1);

namespace App\Action\Specialist;

use App\Domain\Entity\Review;
use App\Domain\Entity\Specialist;
use App\Domain\Repository\ReviewRepository;
use App\Domain\Repository\SpecialistRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/specialists/{id}/reviews?page=&per_page= — patients' reviews of one
 * doctor (and the doctor's replies), newest first, for the back office's
 * doctor page. Needs `specialists.manage`.
 */
final class ListSpecialistReviewsAction
{
    use ApiResponse;

    public function __construct(
        private readonly SpecialistRepository $specialists,
        private readonly ReviewRepository $reviews,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
        array $args,
    ): ResponseInterface {
        /** @var Specialist $specialist */
        $specialist = $this->specialists->findOrFail((string) ($args['id'] ?? ''));
        $p          = $this->getPaginationParams($request->getQueryParams());
        $page       = $this->reviews->paginatedForSpecialist($p['offset'], $p['per_page'], $specialist->getId());

        return $this->paginated(
            $response,
            array_map(static fn (Review $r): array => $r->toArray(), $page['items']),
            $page['total'],
            $p['page'],
            $p['per_page'],
        );
    }
}
