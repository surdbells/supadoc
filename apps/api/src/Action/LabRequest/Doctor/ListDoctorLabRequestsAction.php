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
 * GET /api/doctor/lab-requests?group=&q=&appointment_id=&patient_id=&page=&per_page=
 * — the doctor's own requests, most recent activity first, each with its
 * effective status and the reviewable unreviewed count; `meta.counts` has
 * every group's count (honouring q / appointment / patient, not the group).
 * 422 `group` "Unknown filter".
 */
final class ListDoctorLabRequestsAction
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
        $query = $request->getQueryParams();
        $p     = $this->getPaginationParams($query);
        try {
            $list = $this->service->listForDoctor($doctor, $query, $p['offset'], $p['per_page']);
        } catch (\Throwable $e) {
            return $this->refused($response, $e);
        }

        return $this->pageWithCounts($response, $list['rows'], $list['total'], $p['page'], $p['per_page'], $list['counts']);
    }
}
