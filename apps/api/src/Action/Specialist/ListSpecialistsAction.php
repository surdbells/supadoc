<?php

declare(strict_types=1);

namespace App\Action\Specialist;

use App\Domain\Repository\SpecialistRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/portal/specialists — the bookable specialist directory, paginated,
 * with optional `?search=`, `?specialty=`, `?location=`, `?language=`,
 * `?gender=` and `?mode=in_person`. Only approved (or legacy) doctors who are
 * available for booking are listed; `?available=` is accepted but no longer
 * widens that.
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
        $specialty     = trim((string) ($query['specialty'] ?? ''));
        $location      = trim((string) ($query['location'] ?? ''));
        $language      = trim((string) ($query['language'] ?? ''));
        $gender        = trim((string) ($query['gender'] ?? ''));
        $inPerson      = strtolower(trim((string) ($query['mode'] ?? ''))) === 'in_person' ? true : null;

        $result = $this->repo->paginated(
            $p['offset'],
            $p['per_page'],
            $p['sort_by'],
            $p['sort_dir'],
            $search === '' ? null : $search,
            true, // only doctors taking bookings, whatever `?available=` says
            $specialty === '' ? null : $specialty,
            $location === '' ? null : $location,
            $language === '' ? null : $language,
            $gender === '' ? null : $gender,
            $inPerson,
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
