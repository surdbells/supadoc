<?php

declare(strict_types=1);

namespace App\Infrastructure\Service;

use App\Domain\Entity\Appointment;
use App\Domain\Enum\AppointmentStatus;
use App\Domain\Enum\NotificationType;
use App\Domain\Exception\InsufficientFundsException;
use App\Domain\Exception\ValidationException;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Settings\ClinicTime;
use App\Domain\Settings\WebUrls;
use App\Infrastructure\Email\EmailTemplates;
use App\Infrastructure\Email\MailService;
use DateTimeImmutable;
use DateTimeZone;

/**
 * Follow-up consultations (video, with the same doctor, linked to the
 * consultation they follow on from).
 *
 * The doctor proposes one at one of their open slots (from the call or the
 * appointment record): it is PROPOSED, holds the slot, and closes at
 * {@see expiresAt()} — 2 hours before it starts, and at most 72 hours after it
 * was proposed. The patient accepts it (paying then, unless it is free —
 * optionally at another open slot of the same doctor) or declines it; the
 * doctor may withdraw it; the reminders cron expires it and nudges the
 * patient once before that. Every move out of PROPOSED is a compare-and-set
 * ({@see AppointmentRepository::claimProposal()}), so accept / decline /
 * withdraw / a back-office cancel / expiry racing each other settle on one
 * outcome, and money a losing acceptance took goes back to the wallet.
 *
 * Prices come from {@see PricingService::followUpQuote()}; the final amount is
 * stored on the appointment so refunds use it. Notifications and emails stay
 * generic: never the doctor's note, the reason for the visit, a diagnosis or
 * a medicine.
 */
final class FollowUpService
{
    /** A proposal closes this long before the follow-up starts, so an accepted one is always still bookable. */
    public const CLOSE_HOURS_BEFORE_START = 2;
    /** ...and never stays open longer than this after it was proposed. */
    public const MAX_OPEN_HOURS = 72;
    /** The patient gets at least this long to answer, so a proposed slot starts at least 2h30 from now. */
    public const MIN_OPEN_MINUTES = 30;
    /** The one reminder goes out once a proposal closes within this many hours... */
    public const NUDGE_HOURS_BEFORE_EXPIRY = 24;
    /** ...but never sooner than this after it was proposed (the proposal email is still fresh). */
    public const NUDGE_MIN_AGE_HOURS = 12;
    public const MAX_NOTE_LENGTH   = 1000;
    public const MAX_REASON_LENGTH = 500;
    /** A card checkout doesn't start for a proposal closing sooner than this (the payment would outlive it). */
    public const CHECKOUT_MIN_MINUTES = 15;
    /** A doctor can propose from a confirmed consultation from this long before it starts (joining early). */
    private const IN_CALL_LEAD_MINUTES = 120;

    public function __construct(
        private readonly AppointmentRepository $appointments,
        private readonly AvailabilityService $availability,
        private readonly PricingService $pricing,
        private readonly AppointmentPaymentService $payments,
        private readonly AppointmentCheckout $checkout,
        private readonly AppointmentInvites $invites,
        private readonly PatientNotifier $patientNotifier,
        private readonly StaffNotifier $staffNotifier,
        private readonly MailService $mail,
        private readonly AuditLogger $audit,
    ) {
    }

    // ----- Rules -----

    /** When a proposal for a follow-up starting at `$start` closes: 2h before it starts, at most 72h from `$now`. */
    public static function expiresAt(DateTimeImmutable $start, DateTimeImmutable $now): DateTimeImmutable
    {
        $beforeStart = $start->modify('-' . self::CLOSE_HOURS_BEFORE_START . ' hours');
        $cap         = $now->modify('+' . self::MAX_OPEN_HOURS . ' hours');

        return $beforeStart < $cap ? $beforeStart : $cap;
    }

    /** The earliest start a doctor can propose, so the patient has MIN_OPEN_MINUTES to answer. */
    public static function earliestProposalStart(DateTimeImmutable $now): DateTimeImmutable
    {
        return $now->modify('+' . (self::CLOSE_HOURS_BEFORE_START * 60 + self::MIN_OPEN_MINUTES) . ' minutes');
    }

    /**
     * Why the doctor can't propose a follow-up of `$parent` now, or null: it
     * must be completed, or confirmed and under way (or about to be — the
     * doctor may be in the call a little early).
     */
    public static function doctorParentProblem(Appointment $parent, DateTimeImmutable $now): ?string
    {
        return match ($parent->getStatus()) {
            AppointmentStatus::COMPLETED => null,
            AppointmentStatus::CONFIRMED => $parent->getScheduledAt() <= $now->modify('+' . self::IN_CALL_LEAD_MINUTES . ' minutes')
                ? null
                : "This consultation hasn't taken place yet. You can propose a follow-up during or after the call.",
            default => 'A follow-up can only be proposed from a consultation that is in progress or completed.',
        };
    }

    /**
     * Why the patient can't book a follow-up of `$parent` (theirs, or null when
     * not found) with `$specialistId`, as [field, message], or null.
     *
     * @return array{0:string, 1:string}|null
     */
    public static function patientParentProblem(?Appointment $parent, string $specialistId): ?array
    {
        if ($parent === null) {
            return ['parent_appointment_id', 'Choose one of your consultations to follow up on'];
        }
        if ($parent->getStatus() !== AppointmentStatus::COMPLETED) {
            return ['parent_appointment_id', 'You can book a follow-up once that consultation is completed'];
        }
        if ($parent->getSpecialist()->getId() !== $specialistId) {
            return ['specialist_id', 'A follow-up is booked with the doctor from that consultation'];
        }

        return null;
    }

    /** Why the patient can't accept this proposal now, or null. (An accepted one is answered by the caller first.) */
    public static function responseProblem(Appointment $proposal, DateTimeImmutable $now): ?string
    {
        return match (true) {
            $proposal->isOpenProposal($now)                        => null,
            $proposal->getStatus() === AppointmentStatus::PROPOSED => 'This follow-up proposal has expired. You can book a follow-up from your consultation history instead.',
            $proposal->getProposedBy() === 'doctor'                => 'This follow-up proposal is no longer open.',
            default                                                => 'This appointment is not a follow-up proposal.',
        };
    }

    /** Whether `$start` is the proposal's own time (not another slot the patient picked). */
    public static function isProposedTime(Appointment $proposal, ?DateTimeImmutable $start): bool
    {
        return $start === null || $start->getTimestamp() === $proposal->getScheduledAt()->getTimestamp();
    }

    /**
     * Is the one reminder due for this proposal: still open, not reminded,
     * closing within NUDGE_HOURS_BEFORE_EXPIRY, and at least NUDGE_MIN_AGE_HOURS old.
     */
    public static function isNudgeDue(Appointment $proposal, DateTimeImmutable $now): bool
    {
        $expiresAt = $proposal->getExpiresAt();

        return $proposal->isOpenProposal($now)
            && $proposal->getFollowUpNudgedAt() === null
            && $expiresAt !== null
            && $expiresAt <= $now->modify('+' . self::NUDGE_HOURS_BEFORE_EXPIRY . ' hours')
            && $proposal->getCreatedAt() <= $now->modify('-' . self::NUDGE_MIN_AGE_HOURS . ' hours');
    }

    /** How notices name a time: "Tue 21 Oct, 3:00 PM WAT", on the clinic's clock. */
    public static function whenLabel(DateTimeImmutable $at): string
    {
        return $at->setTimezone(ClinicTime::zone())->format('D j M, g:i A T');
    }

    /**
     * A requested start time: present, valid and in the future — on the
     * server's clock (UTC). Doctrine stores a datetime's wall-clock time
     * without its offset, so "15:00+01:00" must become "14:00" before it is
     * stored or compared, not "15:00".
     *
     * @throws ValidationException
     */
    public static function parseStart(string $raw, string $field = 'scheduled_at'): DateTimeImmutable
    {
        $raw = trim($raw);
        if ($raw === '') {
            throw new ValidationException([$field => 'Please choose a date and time']);
        }
        try {
            $at = new DateTimeImmutable($raw);
        } catch (\Throwable) {
            throw new ValidationException([$field => 'Invalid date/time']);
        }
        if ($at <= new DateTimeImmutable()) {
            throw new ValidationException([$field => 'Please choose a time in the future']);
        }

        return $at->setTimezone(new DateTimeZone(date_default_timezone_get()));
    }

    // ----- Prices -----

    /**
     * What a follow-up of `$parent` starting at `$start` costs, plus what the
     * checkout shows: the currency, and the platform fee (none when it's free).
     *
     * @return array<string,mixed>
     */
    public function quote(Appointment $parent, DateTimeImmutable $start, bool $waived = false): array
    {
        $price = $this->price($parent, $start, $waived);
        $free  = bccomp($price['amount'], '0', 2) <= 0;

        return [
            'parent_appointment_id' => $parent->getId(),
            'scheduled_at'          => $start->format(DATE_ATOM),
            'currency'              => $this->pricing->currency(),
        ] + $price + [
            'within_window' => $start <= new DateTimeImmutable($price['window_ends_at']),
            'free'          => $free,
            'platform_fee'  => $free ? 0.0 : $this->pricing->platformFee(),
        ];
    }

    /**
     * The price record stored on the follow-up ({@see PricingService::followUpPrice()}).
     *
     * @return array{base_fee:string, amount:string, rule:string, discount_percent:int, window_days:int, window_ends_at:string, waived:bool}
     */
    public function price(Appointment $parent, DateTimeImmutable $start, bool $waived = false): array
    {
        return $this->pricing->followUpQuote(
            $parent->getSpecialist()->getConsultationFee(),
            $parent->getScheduledAt(),
            $start,
            $waived,
        );
    }

    /**
     * {@see quote()} for accepting `$proposal` at `$start` (null: the proposed
     * time). At the proposed time the doctor's price stands; another slot is
     * re-quoted for its date, keeping a doctor's waiver.
     *
     * @return array<string,mixed>
     * @throws ValidationException when it is not a follow-up
     */
    public function proposalQuote(Appointment $proposal, ?DateTimeImmutable $start): array
    {
        $parent = $proposal->getParent();
        if ($parent === null) {
            $problem = 'This appointment is not a follow-up proposal.';
            throw new ValidationException(['status' => $problem], $problem);
        }
        $at    = $start ?? $proposal->getScheduledAt();
        $quote = $this->quote($parent, $at, $proposal->isFeeWaived());
        $kept  = $proposal->getFollowUpPricing();
        if ($kept !== null && $at->getTimestamp() === $proposal->getScheduledAt()->getTimestamp()) {
            $quote                 = array_merge($quote, $kept, ['amount' => $proposal->getAmount()]);
            $quote['free']         = $proposal->isFree();
            $quote['platform_fee'] = $proposal->isFree() ? 0.0 : $this->pricing->platformFee();
        }

        return $quote;
    }

    /**
     * The price of accepting `$proposal` at `$start`: its stored amount at the
     * proposed time; re-quoted for another slot (keeping a doctor's waiver).
     */
    public function proposalAmountAt(Appointment $proposal, ?DateTimeImmutable $start): string
    {
        $parent = $proposal->getParent();
        if ($start === null || $parent === null || $start->getTimestamp() === $proposal->getScheduledAt()->getTimestamp()) {
            return $proposal->getAmount();
        }

        return $this->price($parent, $start, $proposal->isFeeWaived())['amount'];
    }

    /**
     * What a card checkout for accepting `$proposal` (the patient's — the
     * caller checked) at `$start` (null: the proposed time) charges, checked
     * first so the patient never pays for an acceptance that would be refused:
     * still open, and for long enough to pay (CHECKOUT_MIN_MINUTES); the doctor
     * still bookable; another slot still open.
     *
     * @throws ValidationException
     */
    public function checkoutAmount(Appointment $proposal, ?DateTimeImmutable $start): string
    {
        $now = new DateTimeImmutable();
        if (($problem = self::responseProblem($proposal, $now)) !== null) {
            throw new ValidationException(['status' => $problem], $problem);
        }
        $expiresAt = $proposal->getExpiresAt();
        if ($expiresAt !== null && $expiresAt < $now->modify('+' . self::CHECKOUT_MIN_MINUTES . ' minutes')) {
            $soon = 'This follow-up proposal closes in a few minutes — too soon to pay by card. Pay from your wallet instead.';
            throw new ValidationException(['status' => $soon], $soon);
        }
        if (($problem = $this->takeProblem($proposal, $start)) !== null) {
            throw new ValidationException([$problem[0] => $problem[1]], $problem[1]);
        }

        return $this->proposalAmountAt($proposal, $start);
    }

    // ----- The doctor proposes -----

    /**
     * The doctor proposes a follow-up of `$parent` (theirs — the caller checked)
     * at one of their open slots.
     *
     * @throws ValidationException
     */
    public function propose(Appointment $parent, string $scheduledRaw, ?string $note, bool $waiveFee): Appointment
    {
        $now = new DateTimeImmutable();
        if (($problem = self::doctorParentProblem($parent, $now)) !== null) {
            throw new ValidationException(['status' => $problem], $problem);
        }

        $start = self::parseStart($scheduledRaw);
        $note  = $note !== null ? trim($note) : null;
        if ($note !== null && mb_strlen($note) > self::MAX_NOTE_LENGTH) {
            throw new ValidationException(['note' => 'Keep the note to ' . self::MAX_NOTE_LENGTH . ' characters or fewer']);
        }
        if ($start < self::earliestProposalStart($now)) {
            throw new ValidationException(['scheduled_at' => 'Choose a time at least 2½ hours from now, so the patient has time to accept']);
        }

        // Checked and saved under a lock on the consultation, so two proposals
        // of it at once (a double click, the call and the record page) can't
        // both find it free. A refusal is handed back, not thrown, so the
        // transaction ends cleanly.
        $proposal = $this->appointments->transactional(function () use ($parent, $start, $note, $waiveFee, $now): Appointment|ValidationException {
            $this->appointments->lockForUpdate($parent);
            if ($this->appointments->openProposalFor($parent->getId(), $now) !== null) {
                $taken = 'This consultation already has a follow-up waiting for the patient. Withdraw it before proposing another time.';

                return new ValidationException(['follow_up' => $taken], $taken);
            }
            // The patient booking rules: on the schedule, not blocked, not taken.
            if (!$this->availability->isSlotAvailable($parent->getSpecialist(), $start)) {
                return new ValidationException(['scheduled_at' => 'That time is not open on your schedule — choose one of your open slots (not blocked or already booked)']);
            }

            $proposal = Appointment::proposeFollowUp($parent, $start, $this->price($parent, $start, $waiveFee), $note, self::expiresAt($start, $now));
            $this->appointments->save($proposal);

            return $proposal;
        });
        if ($proposal instanceof ValidationException) {
            throw $proposal;
        }

        $this->audit->record(
            $parent->getSpecialist()->getName(),
            'doctor',
            'appointment.follow_up_proposed',
            $proposal->getId(),
            'appointment',
            $proposal->getId(),
            [
                'parent_appointment_id' => $parent->getId(),
                'scheduled_at'          => $start->format(DATE_ATOM),
                'expires_at'            => $proposal->getExpiresAt()?->format(DATE_ATOM),
                'amount'                => $proposal->getAmount(),
                'fee_waived'            => $waiveFee,
            ],
        );
        $this->notifyProposed($proposal, false);

        return $proposal;
    }

    // ----- The patient answers -----

    /**
     * The patient accepts `$proposal` (theirs — the caller checked), optionally
     * at another open slot of the same doctor, paying `$method` (wallet | card,
     * with the verified Paystack `$reference`) unless it is free. Returns false
     * when it had already been accepted (a repeat), so nothing is charged or
     * sent twice. A card payment made for an acceptance that is then refused
     * (it closed, or the slot or the doctor went, while the patient paid) is
     * credited to their wallet ({@see refuse()}; 422 `errors.card_payment =
     * credited_to_wallet`). So is one a repeat brings that the follow-up wasn't
     * confirmed with (paid on one device while it was accepted on another),
     * and one a lost race took: `$creditedToWallet` is then the amount credited.
     *
     * @throws ValidationException
     */
    public function accept(Appointment $proposal, string $method, string $reference, ?DateTimeImmutable $start, ?string &$creditedToWallet = null): bool
    {
        $creditedToWallet = null;
        $method           = strtolower(trim($method));
        $reference        = trim($reference);
        if ($proposal->getStatus() === AppointmentStatus::CONFIRMED && $proposal->getProposedBy() === 'doctor') {
            // A repeat: nothing is charged again — but a second card payment
            // it brings would otherwise go unused, so it goes to the wallet.
            if (($stray = self::strayCardReference($proposal, $method, $reference)) !== null) {
                $creditedToWallet = $this->checkout->creditToWallet($stray, $proposal);
            }

            return false;
        }
        $now = new DateTimeImmutable();
        if (($problem = self::responseProblem($proposal, $now)) !== null) {
            $this->refuse($proposal, 'status', $problem, $method, $reference);
        }

        $moved  = !self::isProposedTime($proposal, $start);
        $parent = $proposal->getParent();
        $price  = $moved && $parent !== null ? $this->price($parent, $start, $proposal->isFeeWaived()) : null;
        $amount = $price['amount'] ?? $proposal->getAmount();
        $free   = bccomp($amount, '0', 2) <= 0;
        if (!$free && !in_array($method, ['wallet', 'card'], true)) {
            throw new ValidationException(['payment_method' => 'Choose how to pay: wallet or card']);
        }
        // Before any money moves: the doctor can still be booked, the other slot is still open.
        if (($problem = $this->takeProblem($proposal, $start)) !== null) {
            $this->refuse($proposal, $problem[0], $problem[1], $method, $reference);
        }

        // Money first, for the amount at the chosen time, and the proposal itself
        // is only changed once claimed: the wallet posts (and flushes) in its own
        // transactions, so a short wallet or a bad card reference must leave the
        // stored proposal exactly as the doctor made it. Free → marked paid only.
        if ($free || $method === 'wallet') {
            try {
                $this->payments->chargeForBooking($proposal, $amount);
            } catch (InsufficientFundsException) {
                $short = 'Your wallet balance is too low to accept this follow-up. Pay by card, or top up your wallet and try again.';
                throw new ValidationException(['wallet' => 'insufficient_funds'], $short);
            }
        } else {
            if ($reference === '') {
                throw new ValidationException(['payment_reference' => 'Pay by card first, then confirm with the payment reference']);
            }
            if (($cardError = $this->checkout->verify($reference, $proposal, $amount)) !== null) {
                // Already in the wallet (credited after an earlier refusal): flagged, so the app switches to it.
                $errors = $cardError === AppointmentCheckout::ALREADY_IN_WALLET
                    ? ['payment' => $cardError, 'card_payment' => 'credited_to_wallet']
                    : ['payment' => $cardError];
                throw new ValidationException($errors, $cardError);
            }
        }
        $paidByCard = !$free && $method === 'card';

        // The claim and what it changes (time, price, payment) commit together:
        // if the save fails the claim rolls back, the proposal is still open,
        // and a retry is safe (the wallet debit is keyed on the appointment;
        // the card reference isn't stored, so it verifies again).
        $claimed = $this->appointments->transactional(function () use ($proposal, $now, $moved, $start, $price, $paidByCard, $reference): bool {
            if (!$this->appointments->claimProposal($proposal->getId(), AppointmentStatus::CONFIRMED, $now)) {
                // Drop what this request set in memory before the commit flushes it, and see who won.
                $this->appointments->refresh($proposal);

                return false;
            }
            if ($moved && $start !== null) {
                $price !== null ? $proposal->moveProposal($start, $price) : $proposal->setScheduledAt($start);
            }
            if ($paidByCard) {
                $proposal->payByCard($reference);
            }
            $proposal->transitionTo(AppointmentStatus::CONFIRMED);
            $this->appointments->save($proposal);

            return true;
        });
        if (!$claimed) {
            return $this->lostAcceptRace($proposal, $free ? null : $amount, $paidByCard ? $reference : null, $creditedToWallet);
        }

        $this->audit->record(
            self::patientName($proposal),
            'patient',
            'appointment.follow_up_accepted',
            $proposal->getId(),
            'appointment',
            $proposal->getId(),
            [
                'parent_appointment_id' => $proposal->getParent()?->getId(),
                'scheduled_at'          => $proposal->getScheduledAt()->format(DATE_ATOM),
                'moved'                 => $moved,
                'amount'                => $proposal->getAmount(),
                'payment'               => $proposal->isFree() ? 'free' : $method,
            ],
        );

        if ($paidByCard) {
            $this->checkout->notifyCardPayment($proposal);
        }
        $when = self::whenLabel($proposal->getScheduledAt());
        $this->patientNotifier->notify(
            $proposal->getPatient(),
            NotificationType::APPOINTMENT,
            'Follow-up confirmed',
            sprintf('Your follow-up consultation with %s is confirmed for %s.', $proposal->getSpecialist()->getName(), $when),
            '/dashboard/appointments/' . $proposal->getId(),
        );
        $this->staffNotifier->notifyDoctor(
            $proposal->getSpecialist()->getId(),
            'appointment',
            'Follow-up accepted',
            sprintf('%s accepted the follow-up on %s.', self::patientName($proposal, 'The patient'), $when),
            '/appointments/' . $proposal->getId(),
        );
        $this->invites->send($proposal);

        return true;
    }

    /**
     * The patient declines `$proposal` (theirs — the caller checked). Returns
     * false when it was already closed (a repeat).
     *
     * @throws ValidationException
     */
    public function decline(Appointment $proposal, ?string $reason): bool
    {
        if ($this->alreadyClosed($proposal)) {
            return false;
        }
        if ($proposal->getStatus() !== AppointmentStatus::PROPOSED) {
            $problem = $proposal->getProposedBy() === 'doctor'
                ? 'You already accepted this follow-up — cancel the appointment instead.'
                : 'This appointment is not a follow-up proposal.';
            throw new ValidationException(['status' => $problem], $problem);
        }
        $reason = $reason !== null ? trim($reason) : null;
        if ($reason !== null && mb_strlen($reason) > self::MAX_REASON_LENGTH) {
            throw new ValidationException(['reason' => 'Keep the reason to ' . self::MAX_REASON_LENGTH . ' characters or fewer']);
        }

        if (!$this->close($proposal, 'declined', 'You accepted this follow-up a moment ago — cancel the appointment instead.')) {
            return false;
        }
        $proposal->setDeclineReason($reason);
        $this->appointments->save($proposal);

        $this->audit->record(
            self::patientName($proposal),
            'patient',
            'appointment.follow_up_declined',
            $proposal->getId(),
            'appointment',
            $proposal->getId(),
            ['parent_appointment_id' => $proposal->getParent()?->getId(), 'reason_given' => $reason !== null && $reason !== ''],
        );
        // The doctor reads any reason on the follow-up itself — never in a notice.
        $this->staffNotifier->notifyDoctor(
            $proposal->getSpecialist()->getId(),
            'appointment',
            'Follow-up declined',
            sprintf('%s declined the follow-up proposed for %s.', self::patientName($proposal, 'The patient'), self::whenLabel($proposal->getScheduledAt())),
            '/appointments/' . $proposal->getId(),
        );

        return true;
    }

    // ----- The doctor withdraws -----

    /**
     * The doctor withdraws an unanswered `$proposal` (theirs — the caller
     * checked). Returns false when it was already closed (a repeat).
     *
     * @throws ValidationException
     */
    public function withdraw(Appointment $proposal): bool
    {
        if ($this->alreadyClosed($proposal)) {
            return false;
        }
        if ($proposal->getStatus() !== AppointmentStatus::PROPOSED) {
            $problem = $proposal->getProposedBy() === 'doctor'
                ? 'The patient already accepted this follow-up — cancel the appointment instead.'
                : 'This appointment is not a follow-up proposal.';
            throw new ValidationException(['status' => $problem], $problem);
        }
        if (!$this->close($proposal, 'withdrawn', 'The patient accepted this follow-up a moment ago — cancel the appointment instead.')) {
            return false;
        }

        $this->audit->record(
            $proposal->getSpecialist()->getName(),
            'doctor',
            'appointment.follow_up_withdrawn',
            $proposal->getId(),
            'appointment',
            $proposal->getId(),
            ['parent_appointment_id' => $proposal->getParent()?->getId()],
        );
        $this->notifyClosed($proposal, 'withdrawn');

        return true;
    }

    /**
     * The back office cancels an unanswered `$proposal` (PATCH
     * /appointments/{id}/status): the same compare-and-set as a withdrawal, so
     * a patient accepting it at that moment wins or loses cleanly. The doctor
     * is told here; the caller tells the patient. Returns false when it was
     * already closed (a repeat).
     *
     * @throws ValidationException when the patient accepted it first
     */
    public function cancelByStaff(Appointment $proposal, string $actorName): bool
    {
        if (!$this->close($proposal, 'withdrawn', 'The patient accepted this follow-up a moment ago — cancel the appointment instead.')) {
            return false;
        }

        $this->audit->record(
            $actorName,
            'admin',
            'appointment.follow_up_withdrawn',
            $proposal->getId(),
            'appointment',
            $proposal->getId(),
            ['parent_appointment_id' => $proposal->getParent()?->getId()],
        );
        $this->staffNotifier->notifyDoctor(
            $proposal->getSpecialist()->getId(),
            'appointment',
            'Follow-up cancelled',
            sprintf('The follow-up proposed for %s was cancelled by VideoMed support, so the time is open again.', self::whenLabel($proposal->getScheduledAt())),
            '/appointments/' . $proposal->getId(),
        );

        return true;
    }

    // ----- The reminders cron -----

    /**
     * Expire unanswered proposals past their expiry (→ CANCELLED, both sides
     * told) and nudge patients once about proposals closing soon. Safe to run
     * every few minutes: an expired proposal is never picked again, and the
     * nudge is recorded before it is sent.
     *
     * @return array{expired:int, nudged:int}
     */
    public function housekeeping(?DateTimeImmutable $now = null): array
    {
        $now ??= new DateTimeImmutable();

        return ['expired' => $this->expireDue($now), 'nudged' => $this->nudgeDue($now)];
    }

    public function expireDue(DateTimeImmutable $now): int
    {
        $expired = 0;
        foreach ($this->appointments->expiredProposals($now) as $proposal) {
            if (!$this->appointments->claimProposal($proposal->getId(), AppointmentStatus::CANCELLED)) {
                continue; // answered or withdrawn a moment ago
            }
            $proposal->transitionTo(AppointmentStatus::CANCELLED);
            $proposal->setFollowUpOutcome('expired');
            $this->appointments->save($proposal);

            $this->audit->record(
                'System',
                'system',
                'appointment.follow_up_expired',
                $proposal->getId(),
                'appointment',
                $proposal->getId(),
                ['parent_appointment_id' => $proposal->getParent()?->getId(), 'expires_at' => $proposal->getExpiresAt()?->format(DATE_ATOM)],
            );
            $this->notifyClosed($proposal, 'expired');
            $this->staffNotifier->notifyDoctor(
                $proposal->getSpecialist()->getId(),
                'appointment',
                'Follow-up expired',
                sprintf(
                    "%s didn't reply to the follow-up proposed for %s, so it closed and the time is open again.",
                    self::patientName($proposal, 'The patient'),
                    self::whenLabel($proposal->getScheduledAt()),
                ),
                '/appointments/' . $proposal->getId(),
            );
            ++$expired;
        }

        return $expired;
    }

    public function nudgeDue(DateTimeImmutable $now): int
    {
        $nudged = 0;
        $until  = $now->modify('+' . self::NUDGE_HOURS_BEFORE_EXPIRY . ' hours');
        foreach ($this->appointments->proposalsClosingBy($now, $until) as $proposal) {
            if (!self::isNudgeDue($proposal, $now)) {
                continue; // too fresh — the next runs pick it up as it ages
            }
            // Recorded first: a mail failure must not resend it on every run.
            $proposal->markFollowUpNudged($now);
            $this->appointments->save($proposal);
            $this->notifyProposed($proposal, true);
            ++$nudged;
        }

        return $nudged;
    }

    // ----- Internals -----

    /** A doctor's proposal that is already cancelled — repeating a decline / withdraw is a no-op. */
    private function alreadyClosed(Appointment $proposal): bool
    {
        return $proposal->getStatus() === AppointmentStatus::CANCELLED && $proposal->getProposedBy() === 'doctor';
    }

    /**
     * Claim PROPOSED → CANCELLED, recording how it closed (`$outcome`:
     * declined | withdrawn). False when someone else already closed it;
     * throws `$acceptedMeanwhile` when the patient accepted it first.
     *
     * @throws ValidationException
     */
    private function close(Appointment $proposal, string $outcome, string $acceptedMeanwhile): bool
    {
        if (!$this->appointments->claimProposal($proposal->getId(), AppointmentStatus::CANCELLED)) {
            $this->appointments->refresh($proposal);
            if ($proposal->getStatus() === AppointmentStatus::CANCELLED) {
                return false;
            }
            throw new ValidationException(['status' => $acceptedMeanwhile], $acceptedMeanwhile);
        }
        $proposal->transitionTo(AppointmentStatus::CANCELLED);
        $proposal->setFollowUpOutcome($outcome);
        $this->appointments->save($proposal);

        return true;
    }

    /**
     * Why the patient can't take `$proposal` at `$start` (null: the proposed
     * time), as [field, message], or null: the doctor must still be bookable
     * (not suspended since proposing), and another slot still open.
     *
     * @return array{0:string, 1:string}|null
     */
    private function takeProblem(Appointment $proposal, ?DateTimeImmutable $start): ?array
    {
        if (!$proposal->getSpecialist()->isApproved()) {
            return ['specialist_id', 'This specialist is not currently available'];
        }
        if ($start !== null && !self::isProposedTime($proposal, $start) && !$this->availability->isSlotAvailable($proposal->getSpecialist(), $start)) {
            return ['scheduled_at', 'That time is no longer available — please pick another slot'];
        }

        return null;
    }

    /**
     * Refuse an acceptance with `$message` (on `$field`). When the patient had
     * already paid for it by card — the proposal closed, or the slot or the
     * doctor went, during the checkout — that payment is credited to their
     * wallet first (once per reference; the reference can't then book), the
     * message says so and `errors.card_payment = credited_to_wallet` flags it.
     *
     * @throws ValidationException always
     */
    private function refuse(Appointment $proposal, string $field, string $message, string $method, string $reference): never
    {
        if ($method === 'card' && $reference !== '' && $proposal->getProposedBy() === 'doctor') {
            $credited = $this->checkout->creditToWallet($reference, $proposal);
            if ($credited !== null) {
                $message .= ' ' . $this->walletCreditNote($credited);
                throw new ValidationException([$field => $message, 'card_payment' => 'credited_to_wallet'], $message);
            }
        }
        throw new ValidationException([$field => $message], $message);
    }

    /**
     * The card payment a repeat acceptance of the accepted `$accepted` brings
     * that it wasn't confirmed with — unused unless it goes to the wallet — or
     * null: not by card, no reference, or the very payment it was confirmed with.
     */
    public static function strayCardReference(Appointment $accepted, string $method, string $reference): ?string
    {
        $reference = trim($reference);
        if (strtolower(trim($method)) !== 'card' || $reference === '' || $reference === $accepted->getPaymentReference()) {
            return null;
        }

        return $reference;
    }

    /** "Your card payment of ₦10,000.00 has been added to your VideoMed wallet instead." */
    public function walletCreditNote(string $amount): string
    {
        return sprintf('Your card payment of %s has been added to your VideoMed wallet instead.', $this->moneyLabel($amount));
    }

    /**
     * Someone else answered `$stored` (its stored state) between our checks
     * and the claim: the wallet reference under which what this request took
     * (`$charged`: a wallet debit, or the card payment `$cardReference`; null:
     * nothing, it was free) goes back, or null when the stored follow-up
     * carries it:
     *  - a card payment, unless it is the very one the follow-up was confirmed
     *    with — credited once per reference ({@see AppointmentCheckout::walletCreditKey()});
     *  - a wallet debit, unless another wallet acceptance shared it (the debit
     *    is keyed on the appointment, so both charged once) — so it goes back
     *    when the proposal closed unaccepted, or was accepted by card or for
     *    free. Under its own key: `appt_refund_<id>` stays free for refunding
     *    a later cancellation of the accepted follow-up.
     */
    public static function raceRefundKey(Appointment $stored, ?string $charged, ?string $cardReference): ?string
    {
        if ($charged === null) {
            return null;
        }
        if ($cardReference !== null) {
            return $cardReference !== $stored->getPaymentReference() ? AppointmentCheckout::walletCreditKey($cardReference) : null;
        }
        // Only an acceptance marks it paid (declining, withdrawing, expiring don't).
        $acceptedByWallet = $stored->getPaymentStatus() !== 'unpaid' && $stored->getPaymentReference() === null && !$stored->isFree();

        return $acceptedByWallet ? null : 'fu_race_refund_' . $stored->getId();
    }

    /**
     * Someone else answered between our checks and the claim; `$proposal`
     * holds the stored state. What this request took goes back to the wallet
     * unless the stored follow-up carries it ({@see raceRefundKey()}).
     * Accepted meanwhile → false (a repeat; `$creditedToWallet` is a card
     * payment that went to the wallet); closed → 422, saying where the money went.
     *
     * @throws ValidationException
     */
    private function lostAcceptRace(Appointment $proposal, ?string $charged, ?string $cardReference, ?string &$creditedToWallet): bool
    {
        $returned = null;
        if ($charged !== null && ($key = self::raceRefundKey($proposal, $charged, $cardReference)) !== null) {
            $this->payments->creditBack($proposal, $charged, $key);
            $returned = $charged;
        }
        if ($proposal->getStatus() === AppointmentStatus::CONFIRMED) {
            if ($returned !== null && $cardReference !== null) {
                $creditedToWallet = $returned;
            }

            return false;
        }
        $gone = 'This follow-up proposal is no longer open.';
        if ($returned !== null && $cardReference !== null) {
            $gone .= ' ' . $this->walletCreditNote($returned);
            throw new ValidationException(['status' => $gone, 'card_payment' => 'credited_to_wallet'], $gone);
        }
        if ($returned !== null) {
            $gone .= sprintf(' The %s taken from your wallet has been returned to it.', $this->moneyLabel($returned));
        }
        throw new ValidationException(['status' => $gone], $gone);
    }

    /** "Dr X proposed a follow-up" (or, with `$reminder`, "still waiting for your reply") — in-app + email. */
    private function notifyProposed(Appointment $proposal, bool $reminder): void
    {
        $patient = $proposal->getPatient();
        $doctor  = $proposal->getSpecialist()->getName();
        $when    = self::whenLabel($proposal->getScheduledAt());
        $replyBy = self::whenLabel($proposal->getExpiresAt() ?? $proposal->getScheduledAt());
        $link    = '/dashboard/appointments/' . $proposal->getId();

        $this->patientNotifier->notify(
            $patient,
            NotificationType::APPOINTMENT,
            $reminder ? 'Follow-up awaiting your reply' : 'Follow-up proposed',
            $reminder
                ? sprintf('The follow-up consultation %s proposed for %s closes on %s. Accept it or choose another time before then.', $doctor, $when, $replyBy)
                : sprintf('%s has proposed a follow-up consultation on %s. Accept it or choose another time before %s.', $doctor, $when, $replyBy),
            $link,
        );

        try {
            $p    = $patient->toArray();
            $mail = EmailTemplates::followUpProposed(
                (string) ($p['first_name'] ?? ''),
                $doctor,
                $when,
                $replyBy,
                $this->priceLabel($proposal),
                WebUrls::forPatient($patient) . $link,
                $reminder,
            );
            $this->mail->send((string) ($p['email'] ?? ''), self::patientName($proposal), $mail['subject'], $mail['html']);
        } catch (\Throwable) {
            // logged inside MailService; the proposal already stands.
        }
    }

    /** The proposal closed without a booking (`withdrawn` | `expired`) — the patient is told in-app + by email. */
    private function notifyClosed(Appointment $proposal, string $why): void
    {
        $patient = $proposal->getPatient();
        $doctor  = $proposal->getSpecialist()->getName();
        $when    = self::whenLabel($proposal->getScheduledAt());
        $link    = '/dashboard/appointments/' . $proposal->getId();

        $this->patientNotifier->notify(
            $patient,
            NotificationType::APPOINTMENT,
            $why === 'withdrawn' ? 'Follow-up withdrawn' : 'Follow-up proposal closed',
            $why === 'withdrawn'
                ? sprintf('%s withdrew the follow-up consultation proposed for %s.', $doctor, $when)
                : sprintf('The follow-up consultation %s proposed for %s closed without a reply. You can still book a follow-up from your consultation history.', $doctor, $when),
            $link,
        );

        try {
            $p    = $patient->toArray();
            $mail = EmailTemplates::followUpClosed((string) ($p['first_name'] ?? ''), $doctor, $when, $why, WebUrls::forPatient($patient) . $link);
            $this->mail->send((string) ($p['email'] ?? ''), self::patientName($proposal), $mail['subject'], $mail['html']);
        } catch (\Throwable) {
            // logged inside MailService; the proposal is already closed.
        }
    }

    private function priceLabel(Appointment $appointment): string
    {
        return $appointment->isFree() ? 'Free' : $this->moneyLabel($appointment->getAmount());
    }

    /** "₦10,000.00". */
    private function moneyLabel(string $amount): string
    {
        $currency = $this->pricing->currency() === 'NGN' ? '₦' : $this->pricing->currency();

        return $currency . number_format((float) $amount, 2);
    }

    private static function patientName(Appointment $appointment, string $fallback = ''): string
    {
        $p    = $appointment->getPatient()->toArray();
        $name = trim((string) ($p['first_name'] ?? '') . ' ' . (string) ($p['last_name'] ?? ''));

        return $name !== '' ? $name : $fallback;
    }
}
