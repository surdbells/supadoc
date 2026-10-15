<?php

declare(strict_types=1);

namespace App\Action\Public;

use App\Infrastructure\Availability\DirectorySearch;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/public/specialists?search=&specialty=&limit=&page= — public
 * specialist search for the homepage, the directory and the quiz: at most 24
 * a page (`limit`, default 12), with the same filters as the portal directory
 * — location, language, gender, mode, fee_max, min_rating, min_years and the
 * "when" filters available_on / available_within / part_of_day / tz — and
 * `sort_by` name (default) | rating | consultation_fee | years_experience |
 * reviews_count | soonest. Every doctor carries `availability`; `meta` pages
 * it ({@see DirectorySearch}). Lists only approved (or legacy) doctors who are
 * available for booking.
 */
final class PublicSpecialistsAction
{
    use ApiResponse;

    public function __construct(private readonly DirectorySearch $directory)
    {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        $query = $request->getQueryParams();
        $limit = max(1, min(24, (int) ($query['limit'] ?? 12)));
        $page  = max(1, (int) ($query['page'] ?? 1));

        $p = $this->getPaginationParams(['sort_by' => $query['sort_by'] ?? 'name'] + $query);
        // Names and fees read best low-to-high; ratings, experience and reviews high-to-low.
        $dir = isset($query['sort_dir'])
            ? $p['sort_dir']
            : (in_array($p['sort_by'], ['name', 'consultationFee'], true) ? 'asc' : 'desc');

        $result = $this->directory->search($query, ($page - 1) * $limit, $limit, $p['sort_by'], $dir);

        return $this->paginated($response, $result['items'], $result['total'], $page, $limit);
    }
}
