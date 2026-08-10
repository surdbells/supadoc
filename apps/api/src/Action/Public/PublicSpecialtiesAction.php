<?php

declare(strict_types=1);

namespace App\Action\Public;

use App\Domain\Repository\SpecialistRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/public/specialties — specialties with their specialist counts, for
 * the marketing homepage's "browse by department" section. Public (no auth):
 * the specialist directory is marketing information.
 */
final class PublicSpecialtiesAction
{
    use ApiResponse;

    public function __construct(private readonly SpecialistRepository $repo)
    {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        return $this->success($response, $this->repo->specialtyCounts());
    }
}
