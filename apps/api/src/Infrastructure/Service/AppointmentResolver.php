<?php

declare(strict_types=1);

namespace App\Infrastructure\Service;

use App\Domain\Appointment\AppointmentLifecycle;
use App\Domain\Entity\Appointment;
use App\Domain\Enum\AppointmentStatus;
use App\Domain\Exception\ValidationException;
use App\Domain\Repository\AppointmentRepository;

use App\Domain\Settings\WebUrls;
use App\Infrastructure\Email\EmailTemplates;
use App\Infrastructure\Email\MailService;
use DateTimeImmutable;

/**
 * The back office closing or correcting a consultation — every move audited
 * with who did it and why (actor role `admin`):
 *
 *  - cancel  ({@see cancel()}): an open booking or a missed one → cancelled
 *    (closure_reason staff_cancelled); refunds in full by default (guest
 *    fees included), or nothing / an amount with a reason.
 *  - held    ({@see markHeld()}): a started open booking or a missed one →
 *    completed through {@see ConsultationCompleter} (audit, the patient's
 *    notice, earnings; closure_reason staff_completed; any no-show cleared).
 *  - no_show ({@see markNoShow()}): a past open booking → missed, or a missed
 *    one's party changed; refunds the no-show policy for that party by
 *    default (never taking back what already went back), or full / none / an amount.
 *  - refund  ({@see refund()}): give back more of a closed one (full or an amount).
 *
 * Refund modes: policy | full | none | amount. `full` and `policy` only ever
 * top up to their target, so repeating one refunds nothing more. An `amount`
 * refund posts under `appt_staff_refund_<id>_k_<idempotency_key>` when the
 * client sends a key (a retry or double submit with the same key posts once),
 * else under `appt_staff_refund_<id>_<cents before>_<cents>` (each call is a
 * new refund).
 */
final class AppointmentResolver
{
    public const ACTIONS      = ['held', 'no_show', 'cancel', 'refund'];
    public const REFUND_MODES = ['policy', 'full', 'none', 'amount'];

    public function __construct(
        private readonly AppointmentRepository $appointments,
        private readonly AppointmentPaymentService $payments,
        private readonly ConsultationCompleter $completer,
        private readonly PastAppointmentCloser $closer,
        private readonly GuestInvitations $guests,
        private readonly AuditLogger $audit,
        private readonly PatientNotifier $patientNotifier,
        private readonly StaffNotifier $staffNotifier,
        private readonly MailService $mail,
        private readonly PricingService $pricing,
    ) {
    }

    // ----- Validation -----

    /**
     * The refund mode for `$action` (defaulted), or a 422. `amount` mode needs
     * a positive `$amount`.
     *
     * @throws ValidationException
     */
    public static function refundMode(string $action, mixed $mode, mixed $amount): string
    {
        $allowed = match ($action) {
            'cancel'  => ['full', 'none', 'amount'],
            'held'    => ['none', 'full', 'amount'],
            'no_show' => ['policy', 'full', 'none', 'amount'],
            'refund'  => ['full', 'amount'],
            default   => [],
        };
        $mode = is_string($mode) && trim($mode) !== '' ? strtolower(trim($mode)) : $allowed[0] ?? 'none';
        if (!in_array($mode, $allowed, true)) {
            throw new ValidationException(['refund' => 'Choose one of: ' . implode(', ', $allowed)]);
        }
        if ($mode === 'amount' && (!is_numeric($amount) || bccomp(bcadd((string) $amount, '0', 2), '0', 2) <= 0)) {
            throw new ValidationException(['amount' => 'Enter the amount to refund']);
        }

        return $mode;
    }

    /**
     * A trimmed reason (3–500 characters), or a 422 when `$required` and missing.
     *
     * @throws ValidationException
     */
    public static function reason(mixed $raw, bool $required = true): ?string
    {
        $reason = is_string($raw) ? trim($raw) : '';
        if ($reason === '') {
            if ($required) {
                throw new ValidationException(['reason' => 'Say why (it is kept in the audit trail)']);
            }

            return null;
        }
        if (mb_strlen($reason) < 3 || mb_strlen($reason) > 500) {
            throw new ValidationException(['reason' => 'Keep the reason between 3 and 500 characters']);
        }

        return $reason;
    }

    /**
     * An optional client idempotency key (8–64 of A–Z a–z 0–9 _ -), or a 422.
     *
     * @throws ValidationException
     */
    public static function idempotencyKey(mixed $raw): ?string
    {
        if ($raw === null || $raw === '') {
            return null;
        }
        if (!is_string($raw) || preg_match('/^[A-Za-z0-9_-]{8,64}$/', $raw) !== 1) {
            throw new ValidationException(['idempotency_key' => 'Use 8–64 letters, digits, - or _']);
        }

        return $raw;
    }

    // ----- Moves -----

    /**
     * Cancel an open booking (or a missed consultation). Refunds per `$mode`
     * (full: everything left, guest fees included; none; amount). Returns what
     * was refunded.
     *
     * @param array{id:?string, name:string} $actor
     * @throws ValidationException
     */
    public function cancel(Appointment $appointment, array $actor, string $mode = 'full', ?string $amount = null, ?string $reason = null, ?string $key = null): string
    {
        $from = $appointment->getStatus();
        if ($from === AppointmentStatus::CANCELLED) {
            return '0.00';
        }
        if ($from === AppointmentStatus::PROPOSED) {
            throw new ValidationException(['status' => 'A follow-up proposal is withdrawn, not resolved — cancel it with the status change']);
        }
        if (!$from->canTransitionTo(AppointmentStatus::CANCELLED, true)) {
            throw new ValidationException(['status' => sprintf('A %s consultation can\'t be cancelled', $from->label())]);
        }
        if ($mode === 'none' && $reason === null) {
            throw new ValidationException(['reason' => 'Say why nothing is refunded (it is kept in the audit trail)']);
        }
        $this->checkAmount($appointment, $mode, $amount);

        $refunded = $this->appointments->transactional(function () use ($appointment, $actor, $mode, $amount, $reason, $from, $key): string {
            $this->appointments->lockAndRefresh($appointment);
            if ($appointment->getStatus() !== $from) {
                return '-'; // changed meanwhile
            }
            $appointment->transitionTo(AppointmentStatus::CANCELLED, true);
            $appointment->setClosureReason('staff_cancelled');
            $appointment->setNoShow(null);
            $refunded = match ($mode) {
                'full'   => $this->payments->refundForCancellation($appointment)?->getAmount() ?? '0.00',
                'amount' => $this->staffRefund($appointment, (string) $amount, $key),
                default  => '0.00',
            };
            $this->appointments->save($appointment);
            $this->audit->record($actor['name'], 'admin', 'appointment.cancelled_by_staff', $appointment->getId(), 'appointment', $appointment->getId(), [
                'from'     => $from->value,
                'refund'   => $mode,
                'refunded' => $refunded,
                'reason'   => $reason,
            ], $actor['id']);

            return $refunded;
        });
        if ($refunded === '-') {
            throw new ValidationException(['status' => 'This consultation changed a moment ago — reload it and try again']);
        }

        $this->notifyCancelled($appointment, $refunded);

        return $refunded;
    }

    /**
     * Mark a consultation held: completed (through ConsultationCompleter: the
     * patient is told and it counts towards the doctor's earnings). Only once
     * its time has come. Refunds per `$mode` (default none). Returns what was refunded.
     *
     * @param array{id:?string, name:string} $actor
     * @throws ValidationException
     */
    public function markHeld(Appointment $appointment, array $actor, string $reason, string $mode = 'none', ?string $amount = null, ?string $key = null): string
    {
        $from = $appointment->getStatus();
        if ($from === AppointmentStatus::COMPLETED) {
            throw new ValidationException(['status' => 'This consultation is already completed']);
        }
        if (!$from->canTransitionTo(AppointmentStatus::COMPLETED, true)) {
            throw new ValidationException(['status' => sprintf('A %s consultation can\'t be marked held', $from->label())]);
        }
        if (!AppointmentLifecycle::hasStarted($appointment, new DateTimeImmutable())) {
            throw new ValidationException(['status' => "This consultation hasn't started yet"]);
        }
        $this->checkAmount($appointment, $mode, $amount);

        $claimed = $this->completer->complete(
            $appointment,
            $actor['name'],
            'admin',
            'appointment.completed_by_staff',
            true,
            ['from' => $from->value, 'no_show' => $appointment->getNoShow(), 'reason' => $reason],
            [AppointmentStatus::PENDING, AppointmentStatus::CONFIRMED, AppointmentStatus::RESCHEDULED, AppointmentStatus::MISSED],
            'staff_completed',
            static function (Appointment $a): void {
                $a->setNoShow(null);
            },
            $actor['id'],
        );
        if (!$claimed) {
            throw new ValidationException(['status' => 'This consultation changed a moment ago — reload it and try again']);
        }
        $refunded = $mode === 'none' ? '0.00' : $this->refundNow($appointment, $actor, $mode, $amount, $reason, $key);

        $this->staffNotifier->notifyDoctor(
            $appointment->getSpecialist()->getId(),
            'appointment',
            'Consultation marked held',
            sprintf('The back office marked your consultation with %s on %s as held.', self::patientName($appointment, 'a patient'), FollowUpService::whenLabel($appointment->getScheduledAt())),
            '/appointments/' . $appointment->getId(),
        );

        return $refunded;
    }

    /**
     * Mark a past open booking missed, or change who didn't come to a missed
     * one. Refunds per `$mode`: policy (default — the no-show rules for that
     * party, topping up what already went back), full, none, amount. Returns
     * what was refunded now.
     *
     * @param array{id:?string, name:string} $actor
     * @throws ValidationException
     */
    public function markNoShow(Appointment $appointment, array $actor, string $party, string $reason, string $mode = 'policy', ?string $amount = null, ?string $key = null): string
    {
        if (!in_array($party, AppointmentLifecycle::NO_SHOWS, true)) {
            throw new ValidationException(['no_show' => 'Choose who didn\'t come: doctor, patient or both']);
        }
        $from = $appointment->getStatus();
        $now  = new DateTimeImmutable();
        if ($from !== AppointmentStatus::MISSED) {
            if (!$from->canTransitionTo(AppointmentStatus::MISSED, true)) {
                throw new ValidationException(['status' => sprintf('A %s consultation can\'t be marked missed', $from->label())]);
            }
            if ($now < AppointmentLifecycle::endsAt($appointment)) {
                throw new ValidationException(['status' => "This consultation hasn't ended yet"]);
            }
        } elseif ($appointment->getNoShow() === $party && $mode === 'policy') {
            return '0.00'; // nothing changes
        }
        $this->checkAmount($appointment, $mode, $amount);
        $was = $appointment->getNoShow();

        $refunded = $this->appointments->transactional(function () use ($appointment, $actor, $party, $reason, $mode, $amount, $from, $was, $key): string {
            $this->appointments->lockAndRefresh($appointment);
            if ($appointment->getStatus() !== $from) {
                return '-';
            }
            $appointment->transitionTo(AppointmentStatus::MISSED, true);
            $appointment->setNoShow($party);
            $appointment->setClosureReason('no_show');
            $refunded = match ($mode) {
                'policy' => $this->staffRefund($appointment, $this->policyTopUp($appointment, $party)),
                'full'   => $this->staffRefund($appointment, $appointment->refundableAmount()),
                'amount' => $this->staffRefund($appointment, (string) $amount, $key),
                default  => '0.00',
            };
            $this->appointments->save($appointment);
            $this->audit->record($actor['name'], 'admin', 'appointment.no_show_set', $appointment->getId(), 'appointment', $appointment->getId(), [
                'from'     => $from->value,
                'no_show'  => $party,
                'was'      => $was,
                'refund'   => $mode,
                'refunded' => $refunded,
                'reason'   => $reason,
            ], $actor['id']);

            return $refunded;
        });
        if ($refunded === '-') {
            throw new ValidationException(['status' => 'This consultation changed a moment ago — reload it and try again']);
        }

        $this->closer->announceMissed($appointment, $party, $refunded, $now);

        return $refunded;
    }

    /**
     * Give back more of a closed consultation (completed, missed or cancelled):
     * everything left (`full`) or `$amount`. Returns what was refunded.
     *
     * @param array{id:?string, name:string} $actor
     * @throws ValidationException
     */
    public function refund(Appointment $appointment, array $actor, string $reason, string $mode = 'full', ?string $amount = null, ?string $key = null): string
    {
        if (!$appointment->getStatus()->isTerminal()) {
            throw new ValidationException(['status' => 'Close this consultation first (cancel it, or mark it held or missed)']);
        }
        if (bccomp($appointment->refundableAmount(), '0', 2) <= 0) {
            throw new ValidationException(['refund' => 'Nothing is left to refund on this consultation']);
        }
        $this->checkAmount($appointment, $mode, $amount);

        return $this->refundNow($appointment, $actor, $mode, $amount, $reason, $key);
    }

    // ----- Money -----

    /** The no-show policy refund for `$party` less what already went back (never negative). */
    public function policyTopUp(Appointment $appointment, string $party): string
    {
        $target = AppointmentLifecycle::partialRefund($appointment, $this->closer->refundPercent($party));
        $more   = bcsub($target, $appointment->getRefundedAmount(), 2);

        return bccomp($more, '0', 2) > 0 ? $more : '0.00';
    }

    /**
     * Refund `$amount` (capped at what is left). With the client's `$key` a
     * repeat posts nothing ({@see AppointmentPaymentService::refundPart()}).
     */
    private function staffRefund(Appointment $appointment, string $amount, ?string $key = null): string
    {
        $amount = bcadd($amount, '0', 2);
        $left   = $appointment->refundableAmount();
        if (bccomp($amount, $left, 2) > 0) {
            $amount = $left;
        }
        if (bccomp($amount, '0', 2) <= 0) {
            return '0.00';
        }

        return $this->payments->refundPart(
            $appointment,
            $amount,
            self::staffRefundReference($appointment, $amount, $key),
            'Refund for your consultation with ' . $appointment->getSpecialist()->getName(),
        );
    }

    /** `appt_staff_refund_<id>_k_<key>`, else `appt_staff_refund_<id>_<cents refunded before>_<cents>`. */
    public static function staffRefundReference(Appointment $appointment, string $amount, ?string $key = null): string
    {
        $base = 'appt_staff_refund_' . $appointment->getId() . '_';

        return $key !== null
            ? $base . 'k_' . $key
            : $base . bcmul($appointment->getRefundedAmount(), '100', 0) . '_' . bcmul($amount, '100', 0);
    }

    /**
     * Refund now (its own audited transaction, under the row lock).
     *
     * @param array{id:?string, name:string} $actor
     */
    private function refundNow(Appointment $appointment, array $actor, string $mode, ?string $amount, ?string $reason, ?string $key = null): string
    {
        $refunded = $this->appointments->transactional(function () use ($appointment, $actor, $mode, $amount, $reason, $key): string {
            $this->appointments->lockAndRefresh($appointment);
            $refunded = $this->staffRefund($appointment, $mode === 'amount' ? (string) $amount : $appointment->refundableAmount(), $mode === 'amount' ? $key : null);
            $this->appointments->save($appointment);
            $this->audit->record($actor['name'], 'admin', 'appointment.refunded_by_staff', $appointment->getId(), 'appointment', $appointment->getId(), [
                'status'   => $appointment->getStatus()->value,
                'refund'   => $mode,
                'refunded' => $refunded,
                'reason'   => $reason,
            ], $actor['id']);

            return $refunded;
        });
        if (bccomp($refunded, '0', 2) > 0) {
            $this->patientNotifier->appointment(
                $appointment,
                'Refund issued',
                $this->money($refunded) . ' was refunded to your VideoMed wallet.',
                '/dashboard/history/' . $appointment->getId(),
            );
        }

        return $refunded;
    }

    /** @throws ValidationException */
    private function checkAmount(Appointment $appointment, string $mode, ?string $amount): void
    {
        if ($mode !== 'amount') {
            return;
        }
        $left = $appointment->refundableAmount();
        if (bccomp(bcadd((string) $amount, '0', 2), $left, 2) > 0) {
            throw new ValidationException(['amount' => bccomp($left, '0', 2) > 0
                ? 'At most ' . $this->money($left) . ' can be refunded'
                : 'Nothing is left to refund on this consultation']);
        }
    }

    // ----- Messages (generic: never the reason, a diagnosis or a medicine) -----

    private function notifyCancelled(Appointment $appointment, string $refunded): void
    {
        $refundNote = bccomp($refunded, '0', 2) > 0 ? ' ' . $this->money($refunded) . ' was refunded to your wallet.' : '';
        $this->patientNotifier->appointment($appointment, 'Appointment cancelled', 'Your appointment was cancelled by VideoMed support.' . $refundNote);
        try {
            $p    = $appointment->getPatient()->toArray();
            $mail = EmailTemplates::appointmentStatusUpdate(
                $appointment->toArray(),
                (string) ($p['first_name'] ?? ''),
                WebUrls::forPatient($appointment->getPatient()),
            );
            $this->mail->send(
                (string) ($p['email'] ?? ''),
                trim((string) ($p['first_name'] ?? '') . ' ' . (string) ($p['last_name'] ?? '')),
                $mail['subject'],
                $mail['html'],
            );
        } catch (\Throwable) {
            // logged inside MailService; the cancellation already stands.
        }
        $this->staffNotifier->notifyDoctor(
            $appointment->getSpecialist()->getId(),
            'appointment',
            'Booking cancelled',
            sprintf('The back office cancelled the consultation with %s on %s.', self::patientName($appointment, 'a patient'), FollowUpService::whenLabel($appointment->getScheduledAt())),
            '/appointments/' . $appointment->getId(),
        );
        // Guests are told while their link could still be used — not long after the fact.
        if (new DateTimeImmutable() <= \App\Domain\Call\CallAccess::guestClosesAt($appointment)) {
            $this->guests->notifyCancelled($appointment);
        }
    }

    /** "₦10,000.00". */
    private function money(string $amount): string
    {
        $currency = $this->pricing->currency() === 'NGN' ? '₦' : $this->pricing->currency();

        return $currency . number_format((float) $amount, 2);
    }

    private static function patientName(Appointment $appointment, string $fallback): string
    {
        $p    = $appointment->getPatient()->toArray();
        $name = trim(((string) ($p['first_name'] ?? '')) . ' ' . ((string) ($p['last_name'] ?? '')));

        return $name !== '' ? $name : $fallback;
    }
}
