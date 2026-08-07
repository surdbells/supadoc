<?php

declare(strict_types=1);

namespace App\Action\Appointment;

use App\Domain\Entity\Appointment;
use App\Domain\Entity\Notification;
use App\Domain\Entity\Patient;
use App\Domain\Enum\ConsultationType;
use App\Domain\Enum\NotificationType;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\NotificationRepository;
use App\Domain\Repository\PatientRepository;
use App\Domain\Repository\SpecialistRepository;
use App\Infrastructure\Email\EmailTemplates;
use App\Infrastructure\Email\MailService;
use App\Infrastructure\Service\ApiResponse;
use DateTimeImmutable;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/portal/appointments — the signed-in patient books a consultation.
 * The patient is taken from `customer_id` (never the body), so a customer can
 * only ever book for themselves.
 */
final class CreateMyAppointmentAction
{
    use ApiResponse;

    public function __construct(
        private readonly PatientRepository $patients,
        private readonly SpecialistRepository $specialists,
        private readonly AppointmentRepository $appointments,
        private readonly NotificationRepository $notifications,
        private readonly MailService $mail,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        $customerId   = (string) $request->getAttribute('customer_id');
        $body         = (array) $request->getParsedBody();
        $specialistId = trim((string) ($body['specialist_id'] ?? ''));
        $scheduledRaw = trim((string) ($body['scheduled_at'] ?? ''));
        $typeRaw      = strtolower(trim((string) ($body['type'] ?? 'video')));

        $errors = [];
        if ($specialistId === '') {
            $errors['specialist_id'] = 'Please choose a specialist';
        }

        $type = ConsultationType::tryFrom($typeRaw);
        if ($type === null) {
            $errors['type'] = 'Unknown consultation type';
        }

        $scheduledAt = null;
        if ($scheduledRaw === '') {
            $errors['scheduled_at'] = 'Please choose a date and time';
        } else {
            try {
                $scheduledAt = new DateTimeImmutable($scheduledRaw);
            } catch (\Throwable) {
                $errors['scheduled_at'] = 'Invalid date/time';
            }
        }
        if ($scheduledAt !== null && $scheduledAt <= new DateTimeImmutable()) {
            $errors['scheduled_at'] = 'Please choose a time in the future';
        }

        if ($errors !== []) {
            return $this->error($response, 'Validation failed', 422, $errors);
        }

        /** @var Patient $patient */
        $patient    = $this->patients->findOrFail($customerId);
        // findOrFail throws → 404 if the specialist id is unknown.
        $specialist = $this->specialists->findOrFail($specialistId);

        if (!$specialist->isAvailable()) {
            return $this->error($response, 'Validation failed', 422, [
                'specialist_id' => 'This specialist is not currently available',
            ]);
        }

        $appointment = new Appointment($patient, $specialist, $scheduledAt, $type);
        $this->appointments->save($appointment);

        $this->notifyBooked($patient, $appointment);
        $this->sendConfirmation($appointment, $patient);

        return $this->created($response, $appointment->toArray(), 'Appointment booked');
    }

    /** In-app notification so the booking shows up on the notifications screen. */
    private function notifyBooked(Patient $patient, Appointment $appointment): void
    {
        try {
            $a    = $appointment->toArray();
            $when = (new DateTimeImmutable((string) $a['scheduled_at']))->format('M j, Y \a\t g:i A');
            $this->notifications->save(new Notification(
                $patient,
                NotificationType::APPOINTMENT,
                'Appointment booked',
                sprintf('Your %s with %s is scheduled for %s.', $a['type_label'], $a['specialist']['name'], $when),
            ));
        } catch (\Throwable) {
            // The booking already succeeded; a missing notification isn't fatal.
        }
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
