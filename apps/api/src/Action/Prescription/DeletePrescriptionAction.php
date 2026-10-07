<?php

declare(strict_types=1);

namespace App\Action\Prescription;

use App\Domain\Repository\PrescriptionRepository;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Prescription\PrescriptionService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/** DELETE /api/doctor/prescriptions/{rxId} — discard a draft (sent ones can only be cancelled). */
final class DeletePrescriptionAction
{
    use DoctorPrescriptionSupport;

    public function __construct(
        private readonly UserRepository $users,
        private readonly SpecialistRepository $specialists,
        private readonly PrescriptionRepository $prescriptions,
        private readonly PrescriptionService $service,
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
        $this->service->deleteDraft($rx, $doctor);

        return $this->success($response, null, 'Draft deleted');
    }
}
