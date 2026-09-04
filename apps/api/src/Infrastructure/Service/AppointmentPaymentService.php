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
 */
final class AppointmentPaymentService
{
    public function __construct(private readonly WalletService $wallets)
    {
    }

    /**
     * Debit the appointment amount from the patient's wallet and mark it paid.
     *
     * @throws InsufficientFundsException when the balance is short (no charge made)
     */
    public function chargeForBooking(Appointment $appointment): WalletTransaction
    {
        $currency = $this->wallets->defaultCurrency();
        $txn      = $this->wallets->debit(
            $appointment->getPatient()->getId(),
            $currency,
            $appointment->getAmount(),
            WalletTransaction::TYPE_CONSULTATION,
            'appt_debit_' . $appointment->getId(),
            'Consultation with ' . $appointment->getSpecialist()->getName(),
        );

        $appointment->setPaymentStatus('paid');

        return $txn;
    }

    /**
     * Refund a paid booking back to the wallet (idempotent). No-op unless the
     * appointment is currently marked paid.
     */
    public function refundForCancellation(Appointment $appointment): ?WalletTransaction
    {
        if ($appointment->getPaymentStatus() !== 'paid') {
            return null;
        }

        $currency = $this->wallets->defaultCurrency();
        $txn      = $this->wallets->credit(
            $appointment->getPatient()->getId(),
            $currency,
            $appointment->getAmount(),
            WalletTransaction::TYPE_REFUND,
            'appt_refund_' . $appointment->getId(),
            'Refund for cancelled consultation with ' . $appointment->getSpecialist()->getName(),
        );

        $appointment->setPaymentStatus('refunded');

        return $txn;
    }
}
