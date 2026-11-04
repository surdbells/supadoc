<?php

declare(strict_types=1);

namespace App\Action\LabRequest\Doctor;

use App\Action\LabRequest\LabActionSupport;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Lab\LabRequestService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/doctor/lab-requests/patients?search=&page=&per_page= — the
 * patients this doctor has CONSULTED (LabPatientPickDto rows: name, email,
 * reference "P-XXXXXXXX", last visit), most recent visit first.
 */
final class LabPatientsAction
{
    use LabActionSupport;

    public function __construct(
        private readonly UserRepository $users,
        private readonly SpecialistRepository $specialists,
        private readonly LabRequestService $service,
    ) {
    }

    public function __invoke(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        [$doctor, $denied] = $this->labDoctor($request, $response, $this->users, $this->specialists);
        if ($doctor === null) {
            return $denied;
        }
        $query  = $request->getQueryParams();
        $p      = $this->getPaginationParams($query);
        $search = trim((string) ($query['search'] ?? ''));
        $page   = $this->service->patientPicks($doctor, $search !== '' ? mb_substr($search, 0, 100) : null, $p['offset'], $p['per_page']);

        return $this->noStore($this->paginated($response, $page['items'], $page['total'], $p['page'], $p['per_page']));
    }
}
