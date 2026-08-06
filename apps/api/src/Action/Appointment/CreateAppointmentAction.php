<?php

declare(strict_types=1);

namespace App\Action\Appointment;

use App\Domain\Entity\Appointment;
use App\Domain\Enum\ConsultationType;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\PatientRepository;
use App\Domain\Repository\SpecialistRepository;
use App\Infrastructure\Service\ApiResponse;
use DateTimeImmutable;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/** POST /api/appointments — book a consultation. */
final class CreateAppointmentAction
{
    use ApiResponse;

    public function __construct(
        private readonly PatientRepository $patients,
        private readonly SpecialistRepository $specialists,
        private readonly AppointmentRepository $appointments,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        $body         = (array) $request->getParsedBody();
        $patientId    = trim((string) ($body['patient_id'] ?? ''));
        $specialistId = trim((string) ($body['specialist_id'] ?? ''));
        $scheduledRaw = trim((string) ($body['scheduled_at'] ?? ''));
        $typeRaw      = strtolower(trim((string) ($body['type'] ?? 'video')));

        $errors = [];
        if ($patientId === '') {
            $errors['patient_id'] = 'Patient is required';
        }
        if ($specialistId === '') {
            $errors['specialist_id'] = 'Specialist is required';
        }

        $type = ConsultationType::tryFrom($typeRaw);
        if ($type === null) {
            $errors['type'] = 'Unknown consultation type';
        }

        $scheduledAt = null;
        try {
            $scheduledAt = new DateTimeImmutable($scheduledRaw ?: 'now');
        } catch (\Throwable) {
            $errors['scheduled_at'] = 'Invalid date/time';
        }

        if ($errors !== []) {
            return $this->error($response, 'Validation failed', 422, $errors);
        }

        $patient    = $this->patients->findOrFail($patientId);
        $specialist = $this->specialists->findOrFail($specialistId);

        $appointment = new Appointment($patient, $specialist, $scheduledAt, $type);
        $this->appointments->save($appointment);

        return $this->created($response, $appointment->toArray(), 'Appointment booked');
    }
}
