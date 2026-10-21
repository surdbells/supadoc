<?php

declare(strict_types=1);

namespace App\Action\DocumentSharing;

use App\Domain\Document\DocumentSharingRules as Rules;
use App\Domain\Document\DomainRefusal;
use App\Domain\Entity\Patient;
use App\Domain\Repository\PatientRepository;
use App\Infrastructure\Document\DocumentSharingViews;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/portal/document-access/history?page=&per_page=(≤50)&specialist_id=&document_id=
 * — the patient's disclosure ledger, newest first (PaginatedResponse of
 * DocumentAccessEventDto): every share, change and end, every request and
 * answer, and every time a doctor opened one of their documents. Titles come
 * only from the patient's own documents (null when that document is gone).
 */
final class ListDocumentAccessHistoryAction
{
    use ApiResponse;
    use SharingActionSupport;

    private const MAX_PER_PAGE = 50;

    public function __construct(
        private readonly PatientRepository $patients,
        private readonly DocumentSharingViews $views,
    ) {
    }

    public function __invoke(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        return $this->forPatient($request, $response, $this->patients, function (Patient $p) use ($request, $response): ResponseInterface {
            $query   = $request->getQueryParams();
            $page    = max(1, (int) ($query['page'] ?? 1));
            $perPage = max(1, min(self::MAX_PER_PAGE, (int) ($query['per_page'] ?? 20)));
            $filter  = [];
            foreach (['specialist_id', 'document_id'] as $key) {
                $filter[$key] = null;
                if (($query[$key] ?? '') !== '') {
                    $filter[$key] = Rules::lowerUuid($query[$key]) ?? throw DomainRefusal::field($key, 'Invalid id');
                }
            }
            $result = $this->views->historyDtos($p, ($page - 1) * $perPage, $perPage, $filter['specialist_id'], $filter['document_id']);

            return $this->paginated($response, $result['items'], $result['total'], $page, $perPage);
        });
    }
}
