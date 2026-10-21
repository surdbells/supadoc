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
 * POST /api/portal/document-access/revoke-all — "Stop sharing with everyone":
 * every active share ends at once under one revoke batch (Undo for 10
 * minutes). Requests waiting for an answer stay open. RevokeResultDto.
 */
final class RevokeAllSharingAction
{
    use ApiResponse;
    use SharingActionSupport;

    public function __construct(
        private readonly PatientRepository $patients,
        private readonly DocumentSharingService $sharing,
    ) {
    }

    public function __invoke(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        return $this->forPatient($request, $response, $this->patients, fn (Patient $p): ResponseInterface =>
            $this->success($response, $this->sharing->revokeAll($p, Rules::now()), 'Stopped sharing with everyone'));
    }
}
