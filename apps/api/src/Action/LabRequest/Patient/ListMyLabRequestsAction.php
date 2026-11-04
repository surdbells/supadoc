<?php

declare(strict_types=1);

namespace App\Action\LabRequest\Patient;

use App\Action\LabRequest\LabActionSupport;
use App\Domain\Repository\PatientRepository;
use App\Infrastructure\Lab\LabRequestService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/portal/lab-requests?group=&appointment_id=&page=&per_page= — the
 * patient's own lab requests, most recent activity first, with every group's
 * count in `meta.counts`. Rows name no test and no clinical question.
 */
final class ListMyLabRequestsAction
{
    use LabActionSupport;

    public function __construct(
        private readonly PatientRepository $patients,
        private readonly LabRequestService $service,
    ) {
    }

    public function __invoke(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        [$patient, $denied] = $this->labPatient($request, $response, $this->patients);
        if ($patient === null) {
            return $denied;
        }
        $query = $request->getQueryParams();
        $p     = $this->getPaginationParams($query);
        try {
            $list = $this->service->listForPatient($patient, $query, $p['offset'], $p['per_page']);
        } catch (\Throwable $e) {
            return $this->refused($response, $e);
        }

        return $this->pageWithCounts($response, $list['rows'], $list['total'], $p['page'], $p['per_page'], $list['counts']);
    }
}
