<?php

declare(strict_types=1);

namespace App\Action\Reference;

use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\ReferenceDataService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/reference/{category} — the back office's view of a pick list:
 * every item, active or not, in list order, each with `usage_count` (how many
 * doctors use it, for `specialty`). Staff with `settings.manage` (who edit
 * it) or `specialists.manage` (whose forms offer it). Unknown list → 404.
 */
final class ListReferenceItemsAction
{
    use ApiResponse;

    public function __construct(private readonly ReferenceDataService $reference)
    {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
        array $args,
    ): ResponseInterface {
        return $this->success($response, $this->reference->staffItems((string) ($args['category'] ?? '')))
            ->withHeader('Cache-Control', 'no-store');
    }
}
