<?php

declare(strict_types=1);

namespace App\Action\Patient;

use App\Domain\Document\DocumentSharingRules as Rules;
use App\Domain\Entity\MedicalDocument;
use App\Domain\Entity\Patient;
use App\Domain\Repository\MedicalDocumentRepository;
use App\Domain\Repository\PatientRepository;
use App\Infrastructure\Document\DocumentSharingViews;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Ramsey\Uuid\Uuid;

/**
 * GET /api/portal/documents — the patient's medical documents, with optional
 * `search`, `type` filter, `appointment_id` filter (the files attached to one
 * of their bookings) and `sort_dir` (newest/oldest). Paginated. Every filter
 * narrows the caller's own documents, so none can reach another patient's.
 *
 * Each row carries `shared_with`: the doctors who can see it now (via the
 * whole folder or individually, until when, paused or not) — worked out for
 * the whole page in ONE DocumentAccessPolicy query. When that fails the key is
 * left out (the app then hides the access chips) and the failure is reported.
 */
final class ListMyDocumentsAction
{
    use ApiResponse;

    public function __construct(
        private readonly MedicalDocumentRepository $documents,
        private readonly PatientRepository $patients,
        private readonly DocumentSharingViews $views,
    ) {
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

        $sharedWith = $this->sharedWith($customerId, $page['items']);
        if ($sharedWith !== null) {
            foreach ($items as $i => $item) {
                $items[$i]['shared_with'] = $sharedWith[strtolower((string) $item['id'])] ?? [];
            }
        }

        return $this->paginated($response, $items, $page['total'], $params['page'], $params['per_page']);
    }

    /**
     * Who can see each document of the page, or null when it couldn't be
     * worked out (logged + Sentry; the key is then omitted).
     *
     * @param list<MedicalDocument> $docs
     * @return array<string, list<array<string,mixed>>>|null
     */
    private function sharedWith(string $customerId, array $docs): ?array
    {
        if ($docs === []) {
            return [];
        }
        try {
            $patient = $this->patients->find($customerId);
            if (!$patient instanceof Patient) {
                return null;
            }

            return $this->views->sharedWith($patient, array_map(static fn (MedicalDocument $d): string => $d->getId(), $docs), Rules::now());
        } catch (\Throwable $e) {
            if (function_exists('\Sentry\captureException')) {
                \Sentry\captureException($e);
            }
            error_log('[doc-access] shared_with on the patient list failed: ' . $e::class . ': ' . $e->getMessage());

            return null;
        }
    }
}
