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
 * PATCH /api/portal/document-access/grants/{id} (UpdateDocumentGrantInput) —
 * change how long a share lasts, its scope, or its documents. 404 when not the
 * patient's; 409 `grant_ended` once it ended. The doctor is told only when
 * access widens. DocumentGrantDto (the surviving folder share when two merged).
 */
final class UpdateDocumentGrantAction
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
            $this->success($response, $this->sharing->updateGrant($p, (string) $args['id'], $this->body($request), Rules::now()), 'Changes saved'));
    }
}
