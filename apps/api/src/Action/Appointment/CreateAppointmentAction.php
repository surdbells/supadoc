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
use App\Infrastructure\Service\AvailabilityService;
use App\Infrastructure\Service\PatientNotifier;
use App\Infrastructure\Service\StaffNotifier;
use DateTimeImmutable;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use App\Domain\Settings\WebUrls;

/**
 * POST /api/appointments — a staff member books a consultation on a patient's
 * behalf. Unlike the self-service patient path this does NOT take payment (the
 * booking is created at the correct fee but unpaid, to be settled separately),
 * but it is otherwise held to the same rules: the specialist must be available,
 * the slot must be open (no double-booking), the fee is recorded, and the
 * patient + doctor are notified.
 */
final class CreateAppointmentAction
{
    use ApiResponse;

    public function __construct(
        private readonly PatientRepository $patients,
        private readonly SpecialistRepository $specialists,
        private readonly AppointmentRepository $appointments,
        private readonly MailService $mail,
        private readonly AvailabilityService $availability,
        private readonly PatientNotifier $patientNotifier,
        private readonly StaffNotifier $staffNotifier,
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
        if ($scheduledRaw === '') {
            $errors['scheduled_at'] = 'A date and time is required';
        } else {
            try {
                $scheduledAt = new DateTimeImmutable($scheduledRaw);
            } catch (\Throwable) {
                $errors['scheduled_at'] = 'Invalid date/time';
            }
        }
        if ($scheduledAt !== null && $scheduledAt <= new DateTimeImmutable()) {
            $errors['scheduled_at'] = 'Choose a time in the future';
        }

        if ($errors !== []) {
            return $this->error($response, 'Validation failed', 422, $errors);
        }

        $patient    = $this->patients->findOrFail($patientId);
        $specialist = $this->specialists->findOrFail($specialistId);

        if (!$specialist->isAvailable()) {
            return $this->error($response, 'Validation failed', 422, [
                'specialist_id' => 'This specialist is not currently available',
            ]);
        }
        if (!$this->availability->isSlotAvailable($specialist, $scheduledAt)) {
            return $this->error($response, 'Validation failed', 422, [
                'scheduled_at' => 'That time is not available — please pick another slot',
            ]);
        }

        $appointment = new Appointment($patient, $specialist, $scheduledAt, $type);
        $appointment->setNotes(isset($body['notes']) ? (string) $body['notes'] : null);
        // Record the correct fee even though staff bookings aren't paid here.
        $appointment->setAmount($specialist->getConsultationFee());
        $this->appointments->save($appointment);

        $this->sendConfirmation($appointment, $patient);
        $this->patientNotifier->appointment($appointment, 'Appointment booked', 'An appointment was booked for you.');
        $a = $appointment->toArray();
        $this->staffNotifier->notifyDoctor(
            $specialist->getId(),
            'appointment',
            'New booking',
            'A ' . (string) $a['type_label'] . ' was booked for a patient.',
            '/schedule',
        );

        return $this->created($response, $a, 'Appointment booked');
    }

    /** Fire-and-forget confirmation email — never let it break the booking. */
    private function sendConfirmation(Appointment $appointment, Patient $patient): void
    {
        try {
            $p    = $patient->toArray();
            $mail = EmailTemplates::appointmentConfirmation(
                $appointment->toArray(),
                (string) $p['first_name'],
                WebUrls::forPatient($patient),
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
