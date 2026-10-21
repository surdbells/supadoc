<?php

declare(strict_types=1);

namespace App\Action\DocumentSharing;

use App\Domain\Document\DocumentSharingRules as Rules;
use App\Domain\Document\DomainRefusal;
use App\Domain\Entity\Patient;
use App\Domain\Repository\MedicalDocumentRepository;
use App\Domain\Repository\PatientRepository;
use App\Infrastructure\Document\DocumentSharingService;
use App\Infrastructure\Document\DocumentSharingViews;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * DELETE /api/portal/documents/{id}/access/{specialistId} — "Remove access":
 * the doctor can no longer open this document, through a selected share or
 * the whole folder (a lasting hidden row, so a later folder share respects
 * it too). Everything else shared with them stays. Idempotent.
 * DocumentAccessDetailDto.
 */
final class RemoveDocumentDoctorAccessAction
{
    use ApiResponse;
    use SharingActionSupport;

    public function __construct(
        private readonly PatientRepository $patients,
        private readonly MedicalDocumentRepository $documents,
        private readonly DocumentSharingService $sharing,
        private readonly DocumentSharingViews $views,
    ) {
    }

    public function __invoke(ServerRequestInterface $request, ResponseInterface $response, array $args): ResponseInterface
    {
        return $this->forPatient($request, $response, $this->patients, function (Patient $p) use ($response, $args): ResponseInterface {
            $now = Rules::now();
            $this->sharing->removeDocumentAccess($p, (string) $args['id'], (string) $args['specialistId'], $now);
            $doc = $this->documents->findForPatient((string) $args['id'], $p->getId()) ?? throw DomainRefusal::notFound('This document could not be found.');

            return $this->success($response, $this->views->documentAccess($p, $doc, $now), 'Access removed');
        });
    }
}
