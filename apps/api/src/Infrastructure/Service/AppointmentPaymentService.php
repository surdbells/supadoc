<?php

declare(strict_types=1);

namespace App\Infrastructure\Service;

use App\Domain\Entity\Appointment;
use App\Domain\Entity\WalletTransaction;
use App\Domain\Exception\InsufficientFundsException;

/**
 * Money side of the appointment lifecycle: charge the patient's wallet when they
 * book, and refund it when a paid booking is cancelled. Both postings are
 * idempotent on a deterministic reference derived from the appointment id (so a
 * retried request can't double-charge or double-refund). The receipt email is
 * sent by {@see WalletService} at the posting point, so this service only moves
 * money and flips the appointment's payment_status. The consultation is priced
 * and charged in the wallet's default currency (NGN), matching how the
 * specialist fee is stored.
 *
 * A free consultation (amount 0) never touches the wallet: the ledger only
 * holds positive postings ({@see WalletService::normalise()} rejects 0), so
 * booking one posts nothing and cancelling one refunds nothing.
 */
final class AppointmentPaymentService
{
    public function __construct(private readonly WalletService $wallets)
    {
    }

    /**
     * Debit the appointment amount from the patient's wallet and mark it paid.
     * A free booking is marked paid (nothing is owed) with no posting, and
     * returns null. `$amount` charges a price not stored on the appointment yet
     * (accepting a follow-up at another slot: the time and price change only
     * once it is accepted).
     *
     * @throws InsufficientFundsException when the balance is short (no charge made)
     */
    public function chargeForBooking(Appointment $appointment, ?string $amount = null): ?WalletTransaction
    {
        $amount ??= $appointment->getAmount();
        if (bccomp($amount, '0', 2) <= 0) {
            $appointment->setPaymentStatus('paid');

            return null;
        }

        $currency = $this->wallets->defaultCurrency();
        $txn      = $this->wallets->debit(
            $appointment->getPatient()->getId(),
            $currency,
            $amount,
            WalletTransaction::TYPE_CONSULTATION,
            'appt_debit_' . $appointment->getId(),
            'Consultation with ' . $appointment->getSpecialist()->getName(),
        );

        $appointment->setPaymentStatus('paid');

        return $txn;
    }

    /**
     * Refund a paid booking back to the wallet (idempotent): what is left of
     * it — all of it, unless part already went back (a no-show or back-office
     * refund). No-op unless the appointment is currently marked paid — and for
     * a free booking, which had nothing to refund (it stays `paid`: nothing
     * was ever owed). Records the refund on the appointment (refunded_amount;
     * payment_status `refunded`). `$sendReceipt` false: no wallet receipt
     * email (the cron's quiet backlog).
     */
    public function refundForCancellation(Appointment $appointment, bool $sendReceipt = true): ?WalletTransaction
    {
        if ($appointment->getPaymentStatus() !== 'paid' || $appointment->isFree()) {
            return null;
        }
        $left = $appointment->refundableAmount();
        if (bccomp($left, '0', 2) <= 0) {
            $appointment->setPaymentStatus('refunded');

            return null;
        }

        $currency = $this->wallets->defaultCurrency();
        $txn      = $this->wallets->credit(
            $appointment->getPatient()->getId(),
            $currency,
            $left,
            WalletTransaction::TYPE_REFUND,
            'appt_refund_' . $appointment->getId(),
            'Refund for cancelled consultation with ' . $appointment->getSpecialist()->getName(),
            $sendReceipt,
        );

        $appointment->recordRefund($left);
        $appointment->setPaymentStatus('refunded');

        return $txn;
    }

    /**
     * Refund part of a paid booking — `$amount`, never more than is left to
     * refund ({@see Appointment::refundableAmount()}) — under `$reference`
     * (idempotent: a retry posts nothing twice and records nothing twice), and
     * record it on the appointment. Returns what was refunded ('0.00' when
     * nothing was: unpaid, free, already all refunded, or `$amount` ≤ 0).
     * `$reference` must not be `appt_refund_<id>` (a later cancellation's).
     * `$sendReceipt` false: no wallet receipt email (the cron's quiet backlog).
     */
    public function refundPart(Appointment $appointment, string $amount, string $reference, string $description, bool $sendReceipt = true): string
    {
        $left   = $appointment->refundableAmount();
        $amount = bcadd($amount, '0', 2);
        if (bccomp($amount, $left, 2) > 0) {
            $amount = $left;
        }
        if (bccomp($amount, '0', 2) <= 0 || $this->wallets->hasPosting($reference)) {
            return '0.00';
        }

        $this->wallets->credit(
            $appointment->getPatient()->getId(),
            $this->wallets->defaultCurrency(),
            $amount,
            WalletTransaction::TYPE_REFUND,
            $reference,
            $description,
            $sendReceipt,
        );
        $appointment->recordRefund($amount);

        return $amount;
    }

    /**
     * Credit `$amount` to the patient's wallet for money taken towards
     * `$appointment` that it doesn't keep — a follow-up accepted twice at once,
     * or a card payment whose follow-up closed while the patient paid. The
     * appointment itself is untouched. Idempotent on `$reference`, which must
     * not be `appt_refund_<id>`: a later cancellation refund needs that one.
     */
    public function creditBack(Appointment $appointment, string $amount, string $reference): WalletTransaction
    {
        return $this->wallets->credit(
            $appointment->getPatient()->getId(),
            $this->wallets->defaultCurrency(),
            $amount,
            WalletTransaction::TYPE_REFUND,
            $reference,
            'Refund for consultation with ' . $appointment->getSpecialist()->getName(),
        );
    }

    /**
     * Debit the guest fee for one guest invited after booking (`$guestId`, the
     * id they will get). Idempotent per guest; the caller adds the fee to the
     * appointment amount once the guest is stored, so a cancellation refund
     * includes it.
     *
     * @throws InsufficientFundsException when the balance is short (no charge made)
     */
    public function chargeGuest(Appointment $appointment, string $fee, string $guestId): WalletTransaction
    {
        return $this->wallets->debit(
            $appointment->getPatient()->getId(),
            $this->wallets->defaultCurrency(),
            $fee,
            WalletTransaction::TYPE_CONSULTATION,
            self::guestChargeReference($appointment, $guestId),
            'Guest invitation — consultation with ' . $appointment->getSpecialist()->getName(),
        );
    }

    /** Refund a removed guest's fee to the wallet (idempotent per guest). The caller takes it off the amount. */
    public function refundGuest(Appointment $appointment, string $amount, string $guestId): WalletTransaction
    {
        return $this->wallets->credit(
            $appointment->getPatient()->getId(),
            $this->wallets->defaultCurrency(),
            $amount,
            WalletTransaction::TYPE_REFUND,
            'appt_guest_refund_' . $guestId,
            'Refund for a withdrawn guest invitation — consultation with ' . $appointment->getSpecialist()->getName(),
        );
    }

    /** The ledger reference of a guest's wallet charge (guest ids are unique across appointments). */
    public static function guestChargeReference(Appointment $appointment, string $guestId): string
    {
        return 'appt_guest_' . $guestId;
    }

    /** Whether the wallet ledger already holds an entry under `$reference`. */
    public function isPosted(string $reference): bool
    {
        return $this->wallets->hasPosting($reference);
    }
}
