<?php

declare(strict_types=1);

namespace App\Action\Public;

use App\Domain\Repository\SpecialistRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/public/facets — filter options for the homepage/directory:
 * specialties (with counts), locations and languages. Public (no auth).
 */
final class PublicFacetsAction
{
    use ApiResponse;

    public function __construct(private readonly SpecialistRepository $repo)
    {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        return $this->success($response, [
            'specialties' => $this->repo->specialtyCounts(),
            'locations'   => $this->repo->distinctLocations(),
            'languages'   => $this->repo->distinctLanguages(),
        ]);
    }
}
