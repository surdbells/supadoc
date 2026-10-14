<?php

declare(strict_types=1);

namespace App\Action\Patient;

use App\Domain\Entity\MedicalDocument;
use App\Domain\Repository\MedicalDocumentRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Ramsey\Uuid\Uuid;

/**
 * GET /api/portal/documents — the patient's medical documents, with optional
 * `search`, `type` filter, `appointment_id` filter (the files attached to one
 * of their bookings) and `sort_dir` (newest/oldest). Paginated. Every filter
 * narrows the caller's own documents, so none can reach another patient's.
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

        $search        = isset($query['search']) ? (string) $query['search'] : null;
        $type          = isset($query['type']) ? (string) $query['type'] : null;
        $appointmentId = is_string($query['appointment_id'] ?? null) ? trim($query['appointment_id']) : '';
        if ($appointmentId !== '' && !Uuid::isValid($appointmentId)) {
            return $this->error($response, 'Validation failed', 422, ['appointment_id' => 'Invalid appointment id']);
        }

        $page = $this->documents->paginatedForPatient(
            $customerId,
            $params['offset'],
            $params['per_page'],
            $search,
            $type,
            $params['sort_dir'],
            $appointmentId !== '' ? $appointmentId : null,
        );
        $items = array_map(static fn (MedicalDocument $d): array => $d->toArray(), $page['items']);

        return $this->paginated($response, $items, $page['total'], $params['page'], $params['per_page']);
    }
}
