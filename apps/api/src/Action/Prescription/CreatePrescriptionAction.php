<?php

declare(strict_types=1);

namespace App\Action\Prescription;

use App\Domain\Entity\Appointment;
use App\Domain\Entity\Patient;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\PatientRepository;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Prescription\PrescriptionService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/doctor/prescriptions — start a draft prescription (numbered
 * GVM-RX-YYYYMMDD-NNNNN). With `appointment_id` it belongs to that consultation
 * (during or after the call); without it, `patient_id` must be a patient the
 * doctor has consulted before. The rest of the body is the form (may be partial).
 */
final class CreatePrescriptionAction
{
    use DoctorPrescriptionSupport;

    public function __construct(
        private readonly UserRepository $users,
        private readonly SpecialistRepository $specialists,
        private readonly PatientRepository $patients,
        private readonly AppointmentRepository $appointments,
        private readonly PrescriptionService $service,
    ) {
    }

    public function __invoke(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        [$doctor, $denied] = $this->doctor($request, $response, $this->users, $this->specialists);
        if ($doctor === null) {
            return $denied;
        }
        $body = (array) ($request->getParsedBody() ?? []);

        $appointment   = null;
        $appointmentId = trim((string) ($body['appointment_id'] ?? ''));
        if ($appointmentId !== '') {
            $appointment = $this->appointments->find($appointmentId);
            if (!$appointment instanceof Appointment || $appointment->getSpecialist()->getId() !== $doctor->getId()) {
                return $this->error($response, 'Consultation not found', 404);
            }
            $patient = $appointment->getPatient();
        } else {
            $patient = $this->patients->find(trim((string) ($body['patient_id'] ?? '')));
            if (!$patient instanceof Patient) {
                return $this->error($response, 'Validation failed', 422, ['patient_id' => 'Choose a patient']);
            }
        }

        $rx = $this->service->createDraft($doctor, $patient, $appointment, $body);

        return $this->noStore($this->created($response, $rx->toArray(), 'Draft saved'));
    }
}
