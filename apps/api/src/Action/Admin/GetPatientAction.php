<?php

declare(strict_types=1);

namespace App\Action\Admin;

use App\Domain\Entity\Patient;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\PatientRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/admin/patients/{id} — a patient's account record plus their recent
 * appointments, so an operator can open a patient and see their history.
 * Staff-scoped (monitoring.view). 404 when the id is unknown.
 */
final class GetPatientAction
{
    use ApiResponse;

    public function __construct(
        private readonly PatientRepository $patients,
        private readonly AppointmentRepository $appointments,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
        array $args,
    ): ResponseInterface {
        /** @var Patient $patient */
        $patient = $this->patients->findOrFail((string) $args['id']);

        $appts = $this->appointments->paginated(0, 50, 'scheduledAt', 'desc', $patient->getId());

        return $this->success($response, [
            'patient'             => $patient->toArray(),
            'appointments'        => array_map(static fn ($a) => $a->toArray(), $appts['items']),
            'appointments_total'  => $appts['total'],
        ]);
    }
}
