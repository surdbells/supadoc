<?php

declare(strict_types=1);

namespace App\Action\Appointment;

use App\Domain\Document\BookingAttachments;
use App\Domain\Entity\Appointment;
use App\Domain\Entity\Notification;
use App\Domain\Entity\Patient;
use App\Domain\Enum\ConsultationType;
use App\Domain\Enum\NotificationType;
use App\Domain\Exception\InsufficientFundsException;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\MedicalDocumentRepository;
use App\Domain\Repository\NotificationRepository;
use App\Domain\Repository\PatientRepository;
use App\Domain\Repository\SpecialistRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\AppointmentCheckout;
use App\Infrastructure\Service\AppointmentInvites;
use App\Infrastructure\Service\AppointmentPaymentService;
use App\Infrastructure\Service\AvailabilityService;
use App\Infrastructure\Service\FollowUpService;
use App\Infrastructure\Service\GuestInvitations;
use App\Infrastructure\Service\PricingService;
use App\Infrastructure\Service\StaffNotifier;
use DateTimeImmutable;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Ramsey\Uuid\Uuid;

/**
 * POST /api/portal/appointments — the signed-in patient books a consultation.
 * The patient is taken from `customer_id` (never the body), so a customer can
 * only ever book for themselves.
 *
 * A booking may invite up to 3 third parties (name + email — not the patient's
 * or the doctor's, none twice: 422 `guests.N.email`); each adds the
 * back-office-configured guest fee to the amount and gets a stable guest id and
 * Agora uid. Everyone — patient, doctor and guests — gets a confirmation email
 * with the schedule and a preauthenticated link to join the video call without
 * logging in (a guest's names who invited them). Guests can be changed later
 * (POST/DELETE .../guests).
 *
 * It may also attach up to 10 of the patient's own documents (`document_ids`,
 * uploaded via POST /portal/appointment-documents). Each must be theirs and not
 * already attached to another booking ({@see BookingAttachments}); they are
 * linked in the same transaction that stores the appointment, so the doctor
 * sees them as this booking's files.
 *
 * A free consultation (amount 0) books without any payment.
 *
 * A follow-up: `parent_appointment_id` names one of the patient's completed
 * consultations with the same doctor. The booking then becomes a follow-up of
 * it (type follow_up) priced by the follow-up rules (see PricingService);
 * otherwise everything — payment, status, emails — is the same.
 */
final class CreateMyAppointmentAction
{
    use ApiResponse;

    private const MAX_GUESTS = Appointment::MAX_GUESTS;
    public const MAX_DOCUMENTS = 10;

    /** The authenticated download route that older clients send back as `document_url`. */
    private const LEGACY_DOCUMENT_URL = '#^/api/portal/documents/([0-9a-fA-F-]{36})/file$#';

    public function __construct(
        private readonly PatientRepository $patients,
        private readonly SpecialistRepository $specialists,
        private readonly AppointmentRepository $appointments,
        private readonly MedicalDocumentRepository $documents,
        private readonly NotificationRepository $notifications,
        private readonly AvailabilityService $availability,
        private readonly PricingService $pricing,
        private readonly AppointmentPaymentService $payments,
        private readonly StaffNotifier $notifier,
        private readonly AppointmentCheckout $checkout,
        private readonly AppointmentInvites $invites,
        private readonly FollowUpService $followUps,
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

        [$documentIds, $documentErrors] = $this->parseDocumentIds($body['document_ids'] ?? null, $body['document_url'] ?? null);
        $errors += $documentErrors;

        $parentId = trim((string) ($body['parent_appointment_id'] ?? ''));
        if ($parentId !== '' && !Uuid::isValid($parentId)) {
            $errors['parent_appointment_id'] = 'Choose one of your consultations to follow up on';
        }

        if ($errors !== []) {
            return $this->error($response, 'Validation failed', 422, $errors);
        }

        /** @var Patient $patient */
        $patient    = $this->patients->findOrFail($customerId);
        // findOrFail throws → 404 if the specialist id is unknown.
        $specialist = $this->specialists->findOrFail($specialistId);

        // Only an approved doctor who is switched on for bookings can be booked.
        if (!$specialist->isBookable()) {
            return $this->error($response, 'Validation failed', 422, [
                'specialist_id' => 'This specialist is not currently available',
            ]);
        }

        // A guest is someone else: not the patient, not the doctor, not invited twice.
        $guestErrors = GuestInvitations::bookingGuestProblems($guests, $patient, $specialist);
        if ($guestErrors !== []) {
            return $this->error($response, 'Validation failed', 422, $guestErrors);
        }

        // A follow-up: of one of the patient's own completed consultations, with that doctor.
        $parent = null;
        if ($parentId !== '') {
            $parent  = $this->appointments->findForPatient($parentId, $customerId);
            $problem = FollowUpService::patientParentProblem($parent, $specialist->getId());
            if ($problem !== null) {
                return $this->error($response, 'Validation failed', 422, [$problem[0] => $problem[1]]);
            }
        }

        // The slot must fall on the specialist's schedule, inside the booking
        // window, and still be open.
        if ($this->availability->isBeyondHorizon($scheduledAt)) {
            return $this->error($response, 'Validation failed', 422, [
                'scheduled_at' => 'You can book up to ' . $this->availability->horizonDays() . ' days ahead — please pick an earlier time',
            ]);
        }
        if (!$this->availability->isSlotAvailable($specialist, $scheduledAt)) {
            return $this->error($response, 'Validation failed', 422, [
                'scheduled_at' => 'That time is no longer available — please pick another slot',
            ]);
        }

        // Checked before any money moves, so a bad attachment never leaves a charge.
        $documentErrors = BookingAttachments::problems($documentIds, $this->documents->attachmentStates($customerId, array_values($documentIds)));
        if ($documentErrors !== []) {
            return $this->error($response, 'Validation failed', 422, $documentErrors);
        }

        $appointment = new Appointment($patient, $specialist, $scheduledAt, $type);
        $appointment->setNotes(isset($body['notes']) ? (string) $body['notes'] : null);
        // Each guest gets a stable id + Agora uid; their fee is part of the booking's amount.
        $guestFee = number_format($this->pricing->guestFee(), 2, '.', '');
        $now      = new DateTimeImmutable();
        foreach ($guests as $guest) {
            $appointment->addGuest($guest['name'], $guest['email'], $guestFee, 'booking', null, $now);
        }
        if ($parent !== null) {
            $price = $this->followUps->price($parent, $scheduledAt);
            $appointment->bookAsFollowUpOf($parent, $price);
            $appointment->setAmount($this->totalAmount($price['amount'], count($guests)));
        } else {
            $appointment->setAmount($this->totalAmount($specialist->getConsultationFee(), count($guests)));
        }

        // Two ways to pay: a verified card payment (Paystack reference) or the
        // wallet. Card lets the patient pay the fee directly, without funding a
        // wallet first. A free booking takes the wallet path, which posts nothing.
        $reference = trim((string) ($body['payment_reference'] ?? ''));
        $paidByCard = false;
        if ($reference !== '') {
            $cardError = $this->checkout->verify($reference, $appointment);
            if ($cardError !== null) {
                return $this->error($response, $cardError, 422, ['payment' => $cardError]);
            }
            $appointment->payByCard($reference);
            $paidByCard = true;
        } else {
            // Charge the wallet before persisting: debit throws (with no charge)
            // when the balance is short, so we never create an unpaid appointment.
            // On success the appointment is marked paid and a receipt is emailed;
            // a free booking is just marked paid (no posting, no receipt).
            try {
                $this->payments->chargeForBooking($appointment);
            } catch (InsufficientFundsException) {
                return $this->error(
                    $response,
                    'Your wallet balance is too low to book this consultation. Pay by card, or top up your wallet and try again.',
                    422,
                    ['wallet' => 'insufficient_funds'],
                );
            }
        }

        if ($documentIds === []) {
            $this->appointments->save($appointment);
        } elseif (!$this->documents->saveWithAttachments($appointment, $customerId, array_values($documentIds))) {
            // Another booking took one of the files since the check above, so
            // nothing was booked: the wallet charge goes straight back (a card
            // payment's reference was never stored, so it can book again).
            if (!$paidByCard) {
                $this->payments->refundForCancellation($appointment);
            }

            return $this->error(
                $response,
                'Validation failed',
                422,
                BookingAttachments::problems($documentIds, $this->documents->attachmentStates($customerId, array_values($documentIds)))
                    ?: ['document_ids' => BookingAttachments::TAKEN],
            );
        }

        if ($paidByCard) {
            $this->checkout->notifyCardPayment($appointment);
        }

        $this->notifyBooked($patient, $appointment);
        $this->invites->send($appointment);

        $a = $appointment->toArray();
        $this->notifier->notifyDoctor(
            $specialist->getId(),
            'appointment',
            'New booking',
            trim(((string) $patient->toArray()['first_name']) . ' ' . ((string) $patient->toArray()['last_name']))
                . ' booked a ' . ((string) $a['type_label']) . '.',
            '/schedule',
        );

        return $this->created($response, $a, 'Appointment booked');
    }

    /**
     * The consultation fee (the doctor's, or a follow-up's price) plus the guest
     * fee for each invited third party, as money-as-string (bcmath — never
     * floats for money).
     */
    private function totalAmount(string $fee, int $guestCount): string
    {
        $guestFee = number_format($this->pricing->guestFee(), 2, '.', '');

        return bcadd($fee, bcmul($guestFee, (string) $guestCount, 2), 2);
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
            $name  = trim((string) preg_replace('/\s+/u', ' ', (string) ($entry['name'] ?? '')));
            $email = trim((string) ($entry['email'] ?? ''));

            // Skip fully-blank rows the wizard may submit.
            if ($name === '' && $email === '') {
                continue;
            }
            if ($name === '') {
                $errors["guests.$i.name"] = 'Guest name is required';
            } elseif (mb_strlen($name) > 100) {
                $errors["guests.$i.name"] = 'Keep the guest name to 100 characters or fewer';
            }
            if (mb_strlen($email) > 190 || !filter_var($email, FILTER_VALIDATE_EMAIL)) {
                $errors["guests.$i.email"] = 'A valid guest email is required';
            }
            if (!isset($errors["guests.$i.name"]) && !isset($errors["guests.$i.email"])) {
                $guests[] = ['name' => $name, 'email' => $email];
            }
            $i++;
        }

        return [$guests, $errors];
    }

    /**
     * Normalise + validate `document_ids` (max 10 UUIDs). Keyed by each id's
     * position in the request, so an error's `document_ids.N` points at the
     * entry the client sent; a repeat of an earlier id is dropped. An older
     * client sends one `document_url` instead — the authenticated download
     * route the upload returned — which maps to that document's id.
     *
     * @return array{0: array<int,string>, 1: array<string,string>}
     */
    private function parseDocumentIds(mixed $raw, mixed $legacyUrl): array
    {
        if ($raw === null || $raw === '' || $raw === []) {
            $match = [];
            if (is_string($legacyUrl) && preg_match(self::LEGACY_DOCUMENT_URL, trim($legacyUrl), $match) === 1 && Uuid::isValid($match[1])) {
                return [[strtolower($match[1])], []];
            }

            return [[], []];
        }
        if (!is_array($raw)) {
            return [[], ['document_ids' => 'Invalid document list']];
        }
        if (count($raw) > self::MAX_DOCUMENTS) {
            return [[], ['document_ids' => 'You can attach at most ' . self::MAX_DOCUMENTS . ' documents']];
        }

        $ids    = [];
        $errors = [];
        foreach (array_values($raw) as $i => $id) {
            if (!is_string($id) || !Uuid::isValid(trim($id))) {
                $errors["document_ids.$i"] = 'Invalid document id';
                continue;
            }
            $id = strtolower(trim($id));
            if (!in_array($id, $ids, true)) {
                $ids[$i] = $id;
            }
        }

        return [$ids, $errors];
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
}
