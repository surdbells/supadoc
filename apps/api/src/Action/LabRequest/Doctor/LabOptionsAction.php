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
 * GET /api/doctor/lab-requests/options — the composer's lists (LabOptionsDto):
 * the catalogue version and its active items, specimens, sites, imaging
 * preparations, priorities, purposes, infection alerts, mobility, the form
 * limits and whether the doctor has a saved signature.
 */
final class LabOptionsAction
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

        return $this->noStore($this->success($response, $this->service->options($doctor)));
    }
}
