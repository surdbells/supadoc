<?php

declare(strict_types=1);

namespace App\Action\Reference;

use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\ReferenceDataService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * DELETE /api/reference/{category}/{id} — remove an item nobody uses. One in
 * use is refused with 422 ("In use by N doctors — deactivate it instead",
 * also under `errors.item`), and so is one a change request waiting for review
 * asks for ("Requested by N doctors — deactivate it instead"): switch it off
 * with PATCH instead. `settings.manage`;
 * audited (`reference.deleted`). Unknown list or item → 404.
 */
final class DeleteReferenceItemAction
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
        $id = (string) ($args['id'] ?? '');
        $this->reference->delete((string) ($args['category'] ?? ''), $id, $actorId, $actorName);

        return $this->success($response, ['id' => $id], 'Removed from the list');
    }
}
