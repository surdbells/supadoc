<?php

declare(strict_types=1);

namespace App\Action\DocumentSharing;

use App\Domain\Document\DocumentSharingRules as Rules;
use App\Domain\Entity\Patient;
use App\Domain\Repository\PatientRepository;
use App\Infrastructure\Document\DocumentSharingService;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/portal/document-access/requests/{id}/decline
 * `{ block_future_requests?: boolean }` — decline; optionally stop this
 * doctor asking again (reversible with allow-requests). The doctor is told
 * "declined", never "blocked". 409 `request_not_pending` (+ status) when it
 * is no longer waiting. DocumentAccessRequestDto.
 */
final class DeclineAccessRequestAction
{
    use ApiResponse;
    use SharingActionSupport;

    public function __construct(
        private readonly PatientRepository $patients,
        private readonly DocumentSharingService $sharing,
    ) {
    }

    public function __invoke(ServerRequestInterface $request, ResponseInterface $response, array $args): ResponseInterface
    {
        return $this->forPatient($request, $response, $this->patients, function (Patient $p) use ($request, $response, $args): ResponseInterface {
            $block = filter_var($this->body($request)['block_future_requests'] ?? false, FILTER_VALIDATE_BOOL);

            return $this->success($response, $this->sharing->declineRequest($p, (string) $args['id'], $block, Rules::now()), 'Declined');
        });
    }
}
