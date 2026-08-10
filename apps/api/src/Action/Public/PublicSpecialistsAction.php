<?php

declare(strict_types=1);

namespace App\Action\Public;

use App\Domain\Repository\SpecialistRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/public/specialists?search=&specialty=&limit= — public specialist
 * search for the homepage autocomplete and browse. Capped and unpaginated.
 */
final class PublicSpecialistsAction
{
    use ApiResponse;

    public function __construct(private readonly SpecialistRepository $repo)
    {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        $query     = $request->getQueryParams();
        $search    = trim((string) ($query['search'] ?? ''));
        $specialty = trim((string) ($query['specialty'] ?? ''));
        $location  = trim((string) ($query['location'] ?? ''));
        $language  = trim((string) ($query['language'] ?? ''));
        $gender    = trim((string) ($query['gender'] ?? ''));
        $inPerson  = strtolower(trim((string) ($query['mode'] ?? ''))) === 'in_person' ? true : null;
        $limit     = max(1, min(24, (int) ($query['limit'] ?? 12)));

        $result = $this->repo->paginated(
            0,
            $limit,
            'name',
            'asc',
            $search === '' ? null : $search,
            null,
            $specialty === '' ? null : $specialty,
            $location === '' ? null : $location,
            $language === '' ? null : $language,
            $gender === '' ? null : $gender,
            $inPerson,
        );

        return $this->success(
            $response,
            array_map(static fn ($s) => $s->toArray(), $result['items']),
        );
    }
}
