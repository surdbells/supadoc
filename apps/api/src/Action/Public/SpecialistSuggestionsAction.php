<?php

declare(strict_types=1);

namespace App\Action\Public;

use App\Infrastructure\Availability\SpecialistSuggestions;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/public/specialists/suggestions?like={id}&date=&part_of_day=&tz=
 *     &specialty=&language=&gender=&location=&mode=&fee_max=&limit= — similar
 * doctors free on a date, tiered and each with a reason
 * ({@see SpecialistSuggestions}). `like` excludes that doctor and inherits
 * their specialty and fee; without it `specialty` is required. `date`
 * defaults to today in `tz`. `requested` says whether the `like` doctor is
 * free that date and when they next are. Public (no auth).
 */
final class SpecialistSuggestionsAction
{
    use ApiResponse;

    public function __construct(private readonly SpecialistSuggestions $suggestions)
    {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        return $this->success($response, $this->suggestions->suggest($request->getQueryParams()));
    }
}
