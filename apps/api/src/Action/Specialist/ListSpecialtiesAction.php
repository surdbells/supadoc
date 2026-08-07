<?php

declare(strict_types=1);

namespace App\Action\Specialist;

use App\Domain\Repository\SpecialistRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/portal/specialists/specialties — the distinct specialty list, for
 * the directory's specialty filter.
 */
final class ListSpecialtiesAction
{
    use ApiResponse;

    public function __construct(private readonly SpecialistRepository $repo)
    {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        return $this->success($response, $this->repo->distinctSpecialties());
    }
}
