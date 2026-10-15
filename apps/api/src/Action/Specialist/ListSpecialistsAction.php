<?php

declare(strict_types=1);

namespace App\Action\Specialist;

use App\Infrastructure\Availability\DirectorySearch;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/portal/specialists — the bookable specialist directory, paginated,
 * with optional `?search=`, `?specialty=`, `?location=`, `?language=`,
 * `?gender=`, `?mode=in_person`, `?fee_max=`, `?min_rating=`, `?min_years=`
 * and the "when" filters `?available_on=YYYY-MM-DD` | `?available_within=
 * today|tomorrow|week`, `?part_of_day=morning|afternoon|evening|any` and
 * `?tz=` (the patient's zone; dates are its calendar days). `?sort_by=soonest`
 * orders by the first opening — the default once a date is filtered on. Every
 * doctor carries `availability` ({@see DirectorySearch}). Only approved (or
 * legacy) doctors who are available for booking are listed; `?available=` is
 * accepted but no longer widens that.
 */
final class ListSpecialistsAction
{
    use ApiResponse;

    public function __construct(private readonly DirectorySearch $directory)
    {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        $query  = $request->getQueryParams();
        $p      = $this->getPaginationParams($query);
        $result = $this->directory->search($query, $p['offset'], $p['per_page'], $p['sort_by'], $p['sort_dir']);

        return $this->paginated($response, $result['items'], $result['total'], $p['page'], $p['per_page']);
    }
}
