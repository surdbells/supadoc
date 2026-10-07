<?php

declare(strict_types=1);

namespace App\Action\Prescription;

use App\Domain\Entity\Patient;
use App\Domain\Repository\PatientRepository;
use App\Domain\Repository\PrescriptionRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\AuditLogger;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/portal/prescriptions/{id} — one of the patient's own sent
 * prescriptions (the deep link from the "prescription sent" message lands
 * here). Opening it is audited.
 */
final class MyPrescriptionAction
{
    use ApiResponse;

    public function __construct(
        private readonly PrescriptionRepository $prescriptions,
        private readonly PatientRepository $patients,
        private readonly AuditLogger $audit,
    ) {
    }

    public function __invoke(ServerRequestInterface $request, ResponseInterface $response, array $args): ResponseInterface
    {
        $customerId = (string) $request->getAttribute('customer_id');
        $rx         = $this->prescriptions->findById((string) $args['id']);
        if ($rx === null || $rx->getPatientId() !== $customerId || $rx->isDraft()) {
            return $this->error($response, 'Prescription not found', 404);
        }
        $patient = $this->patients->find($customerId);
        $this->audit->record(
            $patient instanceof Patient ? $patient->getFullName() : 'Patient',
            'patient',
            'prescription.opened',
            $rx->getAppointmentId(),
            'prescription',
            $rx->getId(),
            ['number' => $rx->getNumber()],
        );

        return $this->success($response, $rx->toArray())->withHeader('Cache-Control', 'no-store');
    }
}
