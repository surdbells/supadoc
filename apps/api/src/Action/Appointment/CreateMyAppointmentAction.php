<?php

declare(strict_types=1);

namespace App\Action\Appointment;

use App\Domain\Entity\Appointment;
use App\Domain\Entity\Notification;
use App\Domain\Entity\Patient;
use App\Domain\Entity\Specialist;
use App\Domain\Enum\ConsultationType;
use App\Domain\Enum\NotificationType;
use App\Domain\Exception\InsufficientFundsException;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\NotificationRepository;
use App\Domain\Repository\PatientRepository;
use App\Domain\Repository\SpecialistRepository;
use App\Infrastructure\Email\EmailTemplates;
use App\Infrastructure\Email\MailService;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\AppointmentPaymentService;
use App\Infrastructure\Service\AvailabilityService;
use App\Infrastructure\Service\JwtService;
use App\Infrastructure\Service\PricingService;
use DateTimeImmutable;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/portal/appointments — the signed-in patient books a consultation.
 * The patient is taken from `customer_id` (never the body), so a customer can
 * only ever book for themselves.
 *
 * A booking may invite up to 3 third parties (name + email); each adds the
 * back-office-configured guest fee to the amount. Everyone — patient, doctor and
 * guests — gets a confirmation email with the schedule and a preauthenticated
 * link to join the video call without logging in.
 */
final class CreateMyAppointmentAction
{
    use ApiResponse;

    private const MAX_GUESTS = 3;

    public function __construct(
        private readonly PatientRepository $patients,
        private readonly SpecialistRepository $specialists,
        private readonly AppointmentRepository $appointments,
        private readonly NotificationRepository $notifications,
        private readonly MailService $mail,
        private readonly AvailabilityService $availability,
        private readonly PricingService $pricing,
        private readonly JwtService $jwt,
        private readonly AppointmentPaymentService $payments,
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

        [$guests, $guestErrors] = $this->parseGuests($body['guests'] ?? null);
        $errors += $guestErrors;

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

        // The slot must fall on the specialist's schedule and still be open.
        if (!$this->availability->isSlotAvailable($specialist, $scheduledAt)) {
            return $this->error($response, 'Validation failed', 422, [
                'scheduled_at' => 'That time is no longer available — please pick another slot',
            ]);
        }

        $appointment = new Appointment($patient, $specialist, $scheduledAt, $type);
        $appointment->setNotes(isset($body['notes']) ? (string) $body['notes'] : null);
        $documentUrl = trim((string) ($body['document_url'] ?? ''));
        if ($documentUrl !== '' && str_starts_with($documentUrl, '/uploads/')) {
            $appointment->setDocumentUrl($documentUrl);
        }
        $appointment->setGuests($guests);
        $appointment->setAmount($this->totalAmount($specialist, count($guests)));

        // Charge the wallet before persisting: debit throws (with no charge) when
        // the balance is short, so we never create an unpaid appointment. On
        // success the appointment is marked paid and a receipt email is sent.
        try {
            $this->payments->chargeForBooking($appointment);
        } catch (InsufficientFundsException) {
            return $this->error(
                $response,
                'Your wallet balance is too low to book this consultation. Please top up your wallet and try again.',
                422,
                ['wallet' => 'insufficient_funds'],
            );
        }

        $this->appointments->save($appointment);

        $this->notifyBooked($patient, $appointment);
        $this->sendInvites($appointment, $patient, $specialist, $guests);

        return $this->created($response, $appointment->toArray(), 'Appointment booked');
    }

    /**
     * Base consultation fee plus the guest fee for each invited third party,
     * as money-as-string (bcmath — never floats for money).
     */
    private function totalAmount(Specialist $specialist, int $guestCount): string
    {
        $guestFee = number_format($this->pricing->guestFee(), 2, '.', '');

        return bcadd(
            $specialist->getConsultationFee(),
            bcmul($guestFee, (string) $guestCount, 2),
            2,
        );
    }

    /**
     * Normalise + validate the invited third parties (max 3, each name + email).
     *
     * @return array{0: list<array{name:string,email:string}>, 1: array<string,string>}
     */
    private function parseGuests(mixed $raw): array
    {
        if ($raw === null || $raw === '') {
            return [[], []];
        }
        if (!is_array($raw)) {
            return [[], ['guests' => 'Invalid guest list']];
        }
        if (count($raw) > self::MAX_GUESTS) {
            return [[], ['guests' => 'You can invite at most ' . self::MAX_GUESTS . ' guests']];
        }

        $guests = [];
        $errors = [];
        $i      = 0;
        foreach ($raw as $entry) {
            $entry = (array) $entry;
            $name  = trim((string) ($entry['name'] ?? ''));
            $email = trim((string) ($entry['email'] ?? ''));

            // Skip fully-blank rows the wizard may submit.
            if ($name === '' && $email === '') {
                continue;
            }
            if ($name === '') {
                $errors["guests.$i.name"] = 'Guest name is required';
            }
            if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
                $errors["guests.$i.email"] = 'A valid guest email is required';
            }
            if (!isset($errors["guests.$i.name"]) && !isset($errors["guests.$i.email"])) {
                $guests[] = ['name' => $name, 'email' => $email];
            }
            $i++;
        }

        return [$guests, $errors];
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

    /**
     * Fire-and-forget confirmation emails to every party — patient, doctor and
     * each guest — each with their own preauthenticated join link. Never let a
     * mail failure break the booking.
     *
     * @param list<array{name:string,email:string}> $guests
     */
    private function sendInvites(
        Appointment $appointment,
        Patient $patient,
        Specialist $specialist,
        array $guests,
    ): void {
        try {
            $webUrl   = rtrim((string) ($_ENV['APP_WEB_URL'] ?? 'http://localhost:4201'), '/');
            $currency = $this->pricing->currency() === 'NGN' ? '₦' : $this->pricing->currency();
            $appt     = $appointment->toArray();
            $p        = $patient->toArray();

            $patientName = trim((string) $p['first_name'] . ' ' . (string) $p['last_name']);
            $attendees   = array_merge(
                [$patientName, $specialist->getName()],
                array_map(static fn (array $g): string => $g['name'], $guests),
            );

            // uid must be unique per party in the shared Agora channel.
            $send = function (string $email, string $name, string $role, int $uid) use ($appt, $attendees, $webUrl, $currency): void {
                $token = $this->jwt->issueCallAccess((string) $appt['id'], $name, $role, $uid);
                $mail  = EmailTemplates::sessionInvite($appt, $name, $role, $webUrl . '/call/join/' . $token, $attendees, $currency);
                $this->mail->send($email, $name, $mail['subject'], $mail['html']);
            };

            $send((string) $p['email'], $patientName, 'patient', 1);

            if ($specialist->getEmail() !== null) {
                $send($specialist->getEmail(), $specialist->getName(), 'doctor', 2);
            }

            $uid = 3;
            foreach ($guests as $guest) {
                $send($guest['email'], $guest['name'], 'guest', $uid++);
            }
        } catch (\Throwable) {
            // logged inside MailService; booking already succeeded.
        }
    }
}
