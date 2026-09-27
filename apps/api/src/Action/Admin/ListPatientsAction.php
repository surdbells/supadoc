<?php

declare(strict_types=1);

namespace App\Action\Admin;

use App\Domain\Repository\PatientRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/admin/patients — paginated patient roster for the admin console, with
 * an optional `?search=` (name / email / phone). Staff-scoped (monitoring.view),
 * so an operator can browse the patient base rather than only look one up while
 * booking.
 */
final class ListPatientsAction
{
    use ApiResponse;

    public function __construct(private readonly PatientRepository $patients)
    {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        $query  = $request->getQueryParams();
        $p      = $this->getPaginationParams($query);
        $search = isset($query['search']) ? trim((string) $query['search']) : null;

        $result = $this->patients->paginatedList($p['offset'], $p['per_page'], $search);

        return $this->paginated(
            $response,
            array_map(static fn ($pt) => $pt->toArray(), $result['items']),
            $result['total'],
            $p['page'],
            $p['per_page'],
        );
    }
}
