<?php

declare(strict_types=1);

namespace App\Action\Prescription;

use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Prescription\PrescriptionService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/doctor/prescriptions/options — form defaults and option lists (the
 * admin-set default validity, routes, reading boxes, limits) plus whether the
 * doctor has a saved signature and an MDCN number on file.
 */
final class PrescriptionOptionsAction
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

        return $this->success($response, $this->service->formOptions() + [
            'has_signature' => $doctor->getSignatureKey() !== null,
            'mdcn_number'   => $doctor->getMdcnNumber(),
        ]);
    }
}
