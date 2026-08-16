<?php

declare(strict_types=1);

namespace App\Action\Specialist;

use App\Domain\Entity\Specialist;
use App\Domain\Repository\SpecialistRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/specialists — the back-office specialist list. Staff-scoped and gated
 * on `specialists.manage`. Unlike the public/portal directories, this includes
 * each specialist's (otherwise server-side) contact email so an operator can see
 * and fix it. Ordered by name; the set is small, so it's returned unpaginated.
 */
final class ListSpecialistsAdminAction
{
    use ApiResponse;

    public function __construct(private readonly SpecialistRepository $specialists)
    {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        $page = $this->specialists->paginated(0, 500, 'name', 'asc');

        $rows = array_map(
            static fn (Specialist $s): array => $s->toArray() + ['email' => $s->getEmail()],
            $page['items'],
        );

        return $this->success($response, $rows);
    }
}
