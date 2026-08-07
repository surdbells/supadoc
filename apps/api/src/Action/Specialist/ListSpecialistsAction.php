<?php

declare(strict_types=1);

namespace App\Action\Specialist;

use App\Domain\Repository\SpecialistRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/portal/specialists — the bookable specialist directory, paginated,
 * with optional `?search=` and `?available=true`.
 */
final class ListSpecialistsAction
{
    use ApiResponse;

    public function __construct(private readonly SpecialistRepository $repo)
    {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        $query = $request->getQueryParams();
        $p     = $this->getPaginationParams($query);

        $search        = trim((string) ($query['search'] ?? ''));
        $availableOnly = array_key_exists('available', $query)
            ? filter_var($query['available'], FILTER_VALIDATE_BOOLEAN)
            : null;

        $result = $this->repo->paginated(
            $p['offset'],
            $p['per_page'],
            $p['sort_by'],
            $p['sort_dir'],
            $search === '' ? null : $search,
            $availableOnly,
        );

        return $this->paginated(
            $response,
            array_map(static fn ($s) => $s->toArray(), $result['items']),
            $result['total'],
            $p['page'],
            $p['per_page'],
        );
    }
}
