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
 * POST /api/portal/document-access/grants/{id}/restore — Undo the patient's
 * revoke that ended this grant (and the rest of its batch) within 10
 * minutes; a repeat returns what was restored, later → 409 `restore_expired`.
 * RestoreResultDto.
 */
final class RestoreDocumentGrantAction
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
        return $this->forPatient($request, $response, $this->patients, fn (Patient $p): ResponseInterface =>
            $this->success($response, $this->sharing->restore($p, (string) $args['id'], Rules::now()), 'Sharing restored'));
    }
}
