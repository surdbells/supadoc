<?php

declare(strict_types=1);

namespace App\Action\Patient;

use App\Domain\Entity\MedicalDocument;
use App\Domain\Repository\MedicalDocumentRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/portal/documents — the patient's medical documents, with optional
 * `search`, `type` filter and `sort_dir` (newest/oldest). Paginated.
 */
final class ListMyDocumentsAction
{
    use ApiResponse;

    public function __construct(private readonly MedicalDocumentRepository $documents)
    {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        $customerId = (string) $request->getAttribute('customer_id');
        $query      = $request->getQueryParams();
        $params     = $this->getPaginationParams($query);

        $search = isset($query['search']) ? (string) $query['search'] : null;
        $type   = isset($query['type']) ? (string) $query['type'] : null;

        $page = $this->documents->paginatedForPatient(
            $customerId,
            $params['offset'],
            $params['per_page'],
            $search,
            $type,
            $params['sort_dir'],
        );
        $items = array_map(static fn (MedicalDocument $d): array => $d->toArray(), $page['items']);

        return $this->paginated($response, $items, $page['total'], $params['page'], $params['per_page']);
    }
}
