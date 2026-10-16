<?php

declare(strict_types=1);

namespace App\Action\Reference;

use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\ReferenceDataService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * PATCH /api/reference/{category}/{id} — change an item's `label`,
 * `sort_order` and/or `active` (only the keys sent). Renaming a specialty
 * re-labels every doctor who has the old label (and any change request
 * waiting for review that asks for it) in the same transaction, each audited
 * on the doctor's history; `specialists_updated` in the response says how
 * many doctors changed. Switching an item off hides it from the pick list but
 * leaves it on the doctors who have it. `settings.manage`; audited
 * (`reference.updated`, before/after). 422 per field; unknown list or item → 404.
 */
final class UpdateReferenceItemAction
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
        $item = $this->reference->update(
            (string) ($args['category'] ?? ''),
            (string) ($args['id'] ?? ''),
            (array) $request->getParsedBody(),
            $actorId,
            $actorName,
        );

        $renamed = (int) ($item['specialists_updated'] ?? 0);

        return $this->success(
            $response,
            $item,
            $renamed > 0 ? sprintf('Saved — %d %s updated', $renamed, $renamed === 1 ? 'doctor' : 'doctors') : 'Saved',
        );
    }
}
