<?php

declare(strict_types=1);

namespace App\Action\Appointment;

use App\Domain\Document\BookingAttachments;
use App\Domain\Entity\Appointment;
use App\Domain\Entity\Notification;
use App\Domain\Entity\Patient;
use App\Domain\Entity\PaymentIntent;
use App\Domain\Enum\ConsultationType;
use App\Domain\Enum\NotificationType;
use App\Domain\Exception\InsufficientFundsException;
use App\Domain\Exception\ValidationException;
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
use App\Infrastructure\Service\PaymentIntentService;
use App\Infrastructure\Service\PaymentUse;
use App\Infrastructure\Service\PricingService;
use App\Infrastructure\Service\SlotLock;
use App\Infrastructure\Service\StaffNotifier;
use DateTimeImmutable;
use Doctrine\DBAL\Exception\UniqueConstraintViolationException;
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
 * Paid by card (`payment_reference` from pay-init) or from the wallet. The slot
 * and the money are taken in ONE transaction: the doctor's slot lock
 * ({@see SlotLock}), the availability check again, the insert, then the
 * payment — the card payment consumed atomically (it books once: a second use
 * is 422 "This payment has already been used"; paid above the price → the rest
 * to the wallet), or the wallet debited. A time taken meanwhile is 409
 * `errors.scheduled_at` with nothing booked or charged; a card payment for a
 * booking that can't happen (the time, the doctor or the follow-up went) is
 * credited to the wallet and the answer says so (`errors.card_payment =
 * credited_to_wallet`).
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
        private readonly PaymentIntentService $intents,
        private readonly SlotLock $slots,
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

        // A card payment (Paystack reference from pay-init) pays for exactly this:
        // this patient, this doctor, as this follow-up or not as one.
        $reference = trim((string) ($body['payment_reference'] ?? ''));
        $card      = [
            'reference' => $reference,
            'owner'     => $customerId,
            'context'   => ['specialist_id' => $specialist->getId(), 'parent_appointment_id' => $parentId !== '' ? strtolower($parentId) : null],
        ];

        // A repeat of a booking this card payment already made (the answer was
        // lost, or the app's "Complete your paid booking" after a reload): that
        // booking is the answer — not "time taken", which would invite paying again.
        if (($done = $this->alreadyBookedWith($reference, $customerId, $specialist->getId(), $scheduledAt)) !== null) {
            return $this->success($response, $done->toArray(), 'Appointment already booked with this payment');
        }

        // Only an approved doctor who is switched on for bookings can be booked.
        if (!$specialist->isBookable()) {
            return $this->refuse($response, $card, ['specialist_id' => 'This specialist is not currently available']);
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
                // Paid as this follow-up, which it can no longer be: the payment goes to the wallet.
                return $this->refuse($response, $card, [$problem[0] => $problem[1]]);
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
            // A card payment made for it goes to the wallet (the app then books from the wallet).
            return $this->refuse($response, $card, ['scheduled_at' => 'That time is no longer available — please pick another slot']);
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

        // One transaction takes the slot and the money together: the doctor's
        // slot lock, the availability check again (another booking may have
        // committed since the check above), the insert with its attachments,
        // and the payment — a verified card payment, consumed atomically (one
        // payment books once), or the wallet debit (a free booking posts
        // nothing). Any refusal or failure leaves no booking and no charge.
        // The wallet debit's receipt is sent only once all of it committed.
        $paidByCard = $reference !== '';
        $receipt    = null;
        $book       = function (?PaymentIntent $intent) use ($appointment, $specialist, $scheduledAt, $documentIds, $customerId, &$receipt): PaymentUse {
            $receipt = null;
            $this->slots->lockDoctor($specialist->getId());
            if (!$this->availability->isSlotAvailable($specialist, $scheduledAt)) {
                return PaymentUse::declined('slot', creditToWallet: true);
            }
            if ($intent !== null) {
                $appointment->payByCard($intent->getReference());
            }
            if ($documentIds === []) {
                $this->appointments->save($appointment);
            } elseif (!$this->documents->saveWithAttachments($appointment, $customerId, array_values($documentIds))) {
                // Another booking took one of the files meanwhile: nothing is
                // booked, and a card payment stays unused for the retry.
                return PaymentUse::declined('documents');
            }
            if ($intent === null) {
                $receipt = $this->payments->chargeForBooking($appointment, sendReceipt: false);
            }

            return PaymentUse::used($appointment->getId());
        };

        try {
            $use = $paidByCard
                ? $this->intents->consume($reference, PaymentIntent::PURPOSE_BOOKING, $customerId, $appointment->getAmount(), $book, $card['context'])
                : $this->appointments->transactional(static fn (): PaymentUse => $book(null));
        } catch (ValidationException $e) {
            // Two sends of one booking at once: the first booked, this one found the payment used.
            if ($paidByCard && ($done = $this->alreadyBookedWith($reference, $customerId, $specialist->getId(), $scheduledAt)) !== null) {
                return $this->success($response, $done->toArray(), 'Appointment already booked with this payment');
            }
            throw $e;
        } catch (InsufficientFundsException) {
            return $this->error(
                $response,
                'Your wallet balance is too low to book this consultation. Pay by card, or top up your wallet and try again.',
                422,
                ['wallet' => 'insufficient_funds'],
            );
        } catch (UniqueConstraintViolationException $e) {
            if (!SlotLock::isSlotTaken($e)) {
                throw $e;
            }
            // Booked by a path that didn't wait for the slot lock: nothing was
            // stored or charged; a card payment is still unused.
            $taken = SlotLock::TAKEN . '.' . ($paidByCard ? $this->keptNote() : '');

            return $this->error($response, $taken, 409, ['scheduled_at' => SlotLock::TAKEN]);
        }

        if (!$use->used) {
            if ($use->value === 'documents') {
                return $this->error(
                    $response,
                    'Validation failed',
                    422,
                    BookingAttachments::problems($documentIds, $this->documents->attachmentStates($customerId, array_values($documentIds)))
                        ?: ['document_ids' => BookingAttachments::TAKEN],
                );
            }
            $errors  = ['scheduled_at' => SlotLock::TAKEN];
            $message = SlotLock::TAKEN . '.';
            if ($use->credited !== null) {
                $errors['card_payment'] = 'credited_to_wallet';
                $message .= ' ' . $this->walletNote($use->credited);
            } elseif ($paidByCard) {
                $message .= $this->keptNote();
            }

            return $this->error($response, $message, 409, $errors);
        }

        // Booked and committed: now the wallet receipt (none for a card or free booking).
        $this->payments->sendReceipt($receipt);
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

        $message = 'Appointment booked';
        if ($use->overpaidCredited !== null) {
            $message .= sprintf('. You paid %s more than the price — it was added to your VideoMed wallet.', $this->money($use->overpaidCredited));
        }

        return $this->created($response, $a, $message);
    }

    /**
     * A refusal of this booking (422). When it can't be fixed by trying again
     * with the same card payment — the doctor or the follow-up went, the time
     * was taken — the patient's payment for it goes to their wallet now, and
     * the answer says so (`errors.card_payment = credited_to_wallet`).
     *
     * @param array{reference:string, owner:string, context:array<string,?string>} $card
     * @param array<string,string>                                                $errors
     */
    private function refuse(ResponseInterface $response, array $card, array $errors): ResponseInterface
    {
        $credited = $card['reference'] !== ''
            ? $this->intents->settleUnusedFor($card['reference'], $card['owner'], PaymentIntent::PURPOSE_BOOKING, $card['context'])
            : null;
        if ($credited === null) {
            return $this->error($response, 'Validation failed', 422, $errors);
        }

        return $this->error(
            $response,
            rtrim((string) reset($errors), '.') . '. ' . $this->walletNote($credited),
            422,
            $errors + ['card_payment' => 'credited_to_wallet'],
        );
    }

    /**
     * The patient's open booking with this doctor at this time that card
     * payment `$reference` already paid for — i.e. this very request, sent
     * again — or null (no reference, not used, used for something else, or
     * that booking was moved or is no longer open: then "already used" stands).
     */
    private function alreadyBookedWith(string $reference, string $customerId, string $specialistId, DateTimeImmutable $at): ?Appointment
    {
        $id = $reference !== '' ? $this->intents->usedFor($reference, $customerId, PaymentIntent::PURPOSE_BOOKING) : null;
        if ($id === null || !Uuid::isValid($id)) {
            return null;
        }
        $booked = $this->appointments->findForPatient($id, $customerId);
        if ($booked === null || $booked->getSpecialist()->getId() !== $specialistId || !$booked->getStatus()->isOpenBooking()) {
            return null;
        }
        $when = $booked->getScheduledAt();
        // The same instant (stored as the wall-clock time the booking was given, so either reading counts).
        $same = $when->getTimestamp() === $at->getTimestamp() || $when->format('Y-m-d H:i:s') === $at->format('Y-m-d H:i:s');

        return $same ? $booked : null;
    }

    /** "Your card payment of ₦10,000.00 has been added to your VideoMed wallet — book from your wallet instead." */
    private function walletNote(string $amount): string
    {
        return sprintf('Your card payment of %s has been added to your VideoMed wallet — book from your wallet instead.', $this->money($amount));
    }

    /** Said when a refused booking leaves its card payment unused (it can still book; else the sweep credits it). */
    private function keptNote(): string
    {
        return sprintf(
            ' Your card payment is kept for another time — or, if unused, added to your VideoMed wallet automatically within about %d minutes.',
            $this->intents->creditAfterMinutes(),
        );
    }

    /** "₦5,000.00" (display only — amounts stay decimal strings). */
    private function money(string $amount): string
    {
        $currency           = $this->pricing->currency() === 'NGN' ? '₦' : $this->pricing->currency() . ' ';
        [$whole, $fraction] = array_pad(explode('.', bcadd($amount, '0', 2)), 2, '00');

        return $currency . number_format((int) $whole) . '.' . $fraction;
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
