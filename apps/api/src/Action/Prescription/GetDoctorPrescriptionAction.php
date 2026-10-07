<?php

declare(strict_types=1);

namespace App\Action\Prescription;

use App\Domain\Repository\PrescriptionRepository;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/** GET /api/doctor/prescriptions/{rxId} — one of the doctor's own prescriptions. */
final class GetDoctorPrescriptionAction
{
    use DoctorPrescriptionSupport;

    public function __construct(
        private readonly UserRepository $users,
        private readonly SpecialistRepository $specialists,
        private readonly PrescriptionRepository $prescriptions,
    ) {
    }

    public function __invoke(ServerRequestInterface $request, ResponseInterface $response, array $args): ResponseInterface
    {
        [$doctor, $denied] = $this->doctor($request, $response, $this->users, $this->specialists);
        if ($doctor === null) {
            return $denied;
        }
        $rx = $this->ownPrescription($this->prescriptions, $doctor, (string) $args['rxId']);
        if ($rx === null) {
            return $this->error($response, 'Prescription not found', 404);
        }

        return $this->noStore($this->success($response, $rx->toArray()));
    }
}
