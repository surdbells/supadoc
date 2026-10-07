<?php

declare(strict_types=1);

namespace App\Action\Prescription;

use App\Domain\Repository\PrescriptionRepository;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Prescription\PrescriptionService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/doctor/prescriptions?status=&patient_id=&page=&per_page= — the
 * signed-in doctor's prescriptions (all consultations and standalone), newest
 * first, with each one's effective status.
 */
final class ListDoctorPrescriptionsAction
{
    use DoctorPrescriptionSupport;

    public function __construct(
        private readonly UserRepository $users,
        private readonly SpecialistRepository $specialists,
        private readonly PrescriptionRepository $prescriptions,
        private readonly PrescriptionService $service,
    ) {
    }

    public function __invoke(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        [$doctor, $denied] = $this->doctor($request, $response, $this->users, $this->specialists);
        if ($doctor === null) {
            return $denied;
        }
        $query  = $request->getQueryParams();
        $p      = $this->getPaginationParams($query);
        $status = (string) ($query['status'] ?? '');
        $result = $this->prescriptions->forSpecialist(
            $doctor->getId(),
            isset($query['patient_id']) ? (string) $query['patient_id'] : null,
            in_array($status, ['draft', 'active', 'expired', 'cancelled'], true) ? $status : null,
            $p['offset'],
            $p['per_page'],
        );

        return $this->noStore($this->paginated(
            $response,
            $this->service->rowsFor($result['items']),
            $result['total'],
            $p['page'],
            $p['per_page'],
        ));
    }
}
