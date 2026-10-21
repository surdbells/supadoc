<?php

declare(strict_types=1);

namespace App\Action\DocumentSharing;

use App\Domain\Document\DocumentSharingRules as Rules;
use App\Domain\Document\DomainRefusal;
use App\Domain\Entity\Patient;
use App\Domain\Repository\MedicalDocumentRepository;
use App\Domain\Repository\PatientRepository;
use App\Infrastructure\Document\DocumentSharingViews;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/portal/documents/{id}/access — who can see this document now
 * (including doctors who are paused), whose whole-folder access it is hidden
 * from ("Show again"), the doctors it could be shared with, and its last 20
 * ledger rows. 404 when it isn't the patient's. DocumentAccessDetailDto.
 */
final class GetDocumentAccessAction
{
    use ApiResponse;
    use SharingActionSupport;

    public function __construct(
        private readonly PatientRepository $patients,
        private readonly MedicalDocumentRepository $documents,
        private readonly DocumentSharingViews $views,
    ) {
    }

    public function __invoke(ServerRequestInterface $request, ResponseInterface $response, array $args): ResponseInterface
    {
        return $this->forPatient($request, $response, $this->patients, function (Patient $p) use ($response, $args): ResponseInterface {
            $id  = Rules::lowerUuid($args['id'] ?? null);
            $doc = $id !== null ? $this->documents->findForPatient($id, $p->getId()) : null;
            if ($doc === null) {
                throw DomainRefusal::notFound('This document could not be found.');
            }

            return $this->success($response, $this->views->documentAccess($p, $doc, Rules::now()));
        });
    }
}
