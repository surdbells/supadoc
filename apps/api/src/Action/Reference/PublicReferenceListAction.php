<?php

declare(strict_types=1);

namespace App\Action\Reference;

use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\ReferenceDataService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/public/reference/{category} — a pick list's active items in list
 * order (`id`, `code`, `label`, `sort_order`), e.g. the specialty dropdown of
 * the doctor's onboarding profile and the back office's new-specialist form.
 * Public (no auth) and briefly cacheable; an unknown list is a 404.
 */
final class PublicReferenceListAction
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
        $items = $this->reference->publicItems((string) ($args['category'] ?? ''));

        return $this->success($response, $items)->withHeader('Cache-Control', 'public, max-age=60');
    }
}
