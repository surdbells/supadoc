<?php

declare(strict_types=1);

namespace App\Action\Reference;

use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\ReferenceDataService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/reference/{category}/reorder — `{ids: [...]}`: the list's item
 * ids in the order wanted (items left out follow in their current order).
 * Sort orders become 10, 20, 30… Returns the whole list (as GET does).
 * `settings.manage`; audited (`reference.reordered`, labels before/after).
 * 422 when `ids` is missing, repeats an id or names an item of another list.
 */
final class ReorderReferenceItemsAction
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
        $body  = (array) $request->getParsedBody();
        $items = $this->reference->reorder((string) ($args['category'] ?? ''), $body['ids'] ?? null, $actorId, $actorName);

        return $this->success($response, $items, 'Order saved');
    }
}
