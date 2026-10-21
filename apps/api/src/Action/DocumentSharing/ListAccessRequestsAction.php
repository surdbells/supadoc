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
 * GET /api/portal/document-access/requests?status=pending|all — doctors'
 * requests to see the patient's documents (DocumentAccessRequestDto[]):
 * `pending` = waiting and not past their close; `all` = the last 90 days.
 * Each carries the server's suggestion for one-tap Approve.
 */
final class ListAccessRequestsAction
{
    use ApiResponse;
    use SharingActionSupport;

    public function __construct(
        private readonly PatientRepository $patients,
        private readonly DocumentAccessRequestRepository $requests,
        private readonly DocumentSharingViews $views,
    ) {
    }

    public function __invoke(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        return $this->forPatient($request, $response, $this->patients, function (Patient $p) use ($request, $response): ResponseInterface {
            $status = (string) ($request->getQueryParams()['status'] ?? 'pending');
            if (!in_array($status, ['pending', 'all'], true)) {
                throw DomainRefusal::field('status', 'Use status pending or all');
            }
            $now = Rules::now();

            return $this->success($response, $this->views->requestDtos($p, $this->requests->listForPatient($p->getId(), $status, $now), $now));
        });
    }
}
