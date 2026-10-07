<?php

declare(strict_types=1);

namespace App\Action\Prescription;

use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Prescription\PrescriptionService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/doctor/drugs?q=amoxicillin 500 — search the RxNorm prescribable
 * catalogue (generic products first; INN names such as "paracetamol" map to
 * their RxNorm names). Doctors only.
 */
final class SearchDrugsAction
{
    use DoctorPrescriptionSupport;

    public function __construct(
        private readonly UserRepository $users,
        private readonly SpecialistRepository $specialists,
        private readonly PrescriptionService $service,
    ) {
    }

    public function __invoke(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        [$doctor, $denied] = $this->doctor($request, $response, $this->users, $this->specialists);
        if ($doctor === null) {
            return $denied;
        }
        $query = $request->getQueryParams();
        $q     = trim((string) ($query['q'] ?? ''));
        $limit = (int) ($query['limit'] ?? 20);

        return $this->success($response, $this->service->searchDrugs($q, $limit > 0 ? $limit : 20));
    }
}
