<?php

declare(strict_types=1);

namespace App\Action\DocumentSharing;

use App\Domain\Document\DocumentSharingRules as Rules;
use App\Domain\Document\DomainRefusal;
use App\Domain\Entity\Patient;
use App\Domain\Repository\DocumentAccessRequestRepository;
use App\Domain\Repository\PatientRepository;
use App\Infrastructure\Document\DocumentSharingViews;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/portal/document-access/requests/{id} — one of the patient's
 * requests (any status: the app explains an answered or closed one). 404
 * when it isn't theirs. DocumentAccessRequestDto.
 */
final class GetAccessRequestAction
{
    use ApiResponse;
    use SharingActionSupport;

    public function __construct(
        private readonly PatientRepository $patients,
        private readonly DocumentAccessRequestRepository $requests,
        private readonly DocumentSharingViews $views,
    ) {
    }

    public function __invoke(ServerRequestInterface $request, ResponseInterface $response, array $args): ResponseInterface
    {
        return $this->forPatient($request, $response, $this->patients, function (Patient $p) use ($response, $args): ResponseInterface {
            $id  = Rules::lowerUuid($args['id'] ?? null);
            $row = $id !== null ? $this->requests->rowForPatient($id, $p->getId()) : null;
            $dto = $row !== null ? $this->views->requestDto($p, $row, Rules::now()) : null;
            if ($dto === null) {
                throw DomainRefusal::notFound('This request could not be found.');
            }

            return $this->success($response, $dto);
        });
    }
}
