<?php

declare(strict_types=1);

namespace App\Action\Reference;

use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\ReferenceDataService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/reference/{category} — add an item to a pick list: `label`
 * (required, at most 120 characters, not already on the list in any case),
 * optional `code` (a lower-case slug; made from the label when absent),
 * `sort_order` (default: after the last item) and `active` (default true).
 * `settings.manage`; audited (`reference.created`). 201 with the item;
 * 422 per field; unknown list → 404.
 */
final class CreateReferenceItemAction
{
    use ApiResponse;
    use ResolvesReferenceActor;

    public function __construct(
        private readonly ReferenceDataService $reference,
        private readonly UserRepository $users,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
        array $args,
    ): ResponseInterface {
        [$actorId, $actorName] = $this->actor($request, $this->users);
        $item = $this->reference->create(
            (string) ($args['category'] ?? ''),
            (array) $request->getParsedBody(),
            $actorId,
            $actorName,
        );

        return $this->created($response, $item, 'Added to the list');
    }
}
