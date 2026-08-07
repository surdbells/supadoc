<?php

declare(strict_types=1);

namespace App\Action\Appointment;

use App\Domain\Entity\Appointment;
use App\Domain\Entity\Patient;
use App\Domain\Enum\ConsultationType;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\PatientRepository;
use App\Domain\Repository\SpecialistRepository;
use App\Infrastructure\Email\EmailTemplates;
use App\Infrastructure\Email\MailService;
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
        private readonly MailService $mail,
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

        $this->sendConfirmation($appointment, $patient);

        return $this->created($response, $appointment->toArray(), 'Appointment booked');
    }

    /** Fire-and-forget confirmation email — never let it break the booking. */
    private function sendConfirmation(Appointment $appointment, Patient $patient): void
    {
        try {
            $p    = $patient->toArray();
            $mail = EmailTemplates::appointmentConfirmation(
                $appointment->toArray(),
                (string) $p['first_name'],
                $_ENV['APP_WEB_URL'] ?? 'http://localhost:4201',
            );
            $this->mail->send(
                (string) $p['email'],
                trim((string) $p['first_name'] . ' ' . (string) $p['last_name']),
                $mail['subject'],
                $mail['html'],
            );
        } catch (\Throwable) {
            // logged inside MailService; booking already succeeded.
        }
    }
}
