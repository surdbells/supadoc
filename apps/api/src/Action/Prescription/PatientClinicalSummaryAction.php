<?php

declare(strict_types=1);

namespace App\Action\Prescription;

use App\Domain\Entity\Patient;
use App\Domain\Repository\PatientRepository;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Prescription\PrescriptionService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/doctor/patients/{id}/clinical-summary — the read-only side panel
 * shown while prescribing: allergies (most serious first), latest readings,
 * current medicines grouped by what they're for, and whether to ask the
 * pregnancy question. Only for a patient this doctor has consulted.
 */
final class PatientClinicalSummaryAction
{
    use DoctorPrescriptionSupport;

    public function __construct(
        private readonly UserRepository $users,
        private readonly SpecialistRepository $specialists,
        private readonly PatientRepository $patients,
        private readonly PrescriptionService $service,
    ) {
    }

    public function __invoke(ServerRequestInterface $request, ResponseInterface $response, array $args): ResponseInterface
    {
        [$doctor, $denied] = $this->doctor($request, $response, $this->users, $this->specialists);
        if ($doctor === null) {
            return $denied;
        }
        $patient = $this->patients->find((string) $args['id']);
        if (!$patient instanceof Patient || !$this->service->hasConsulted($doctor, $patient)) {
            return $this->error($response, 'Patient not found', 404);
        }

        return $this->noStore($this->success($response, $this->service->clinicalSummary($patient)));
    }
}
