<?php

declare(strict_types=1);

namespace App\Infrastructure\Service;

use App\Domain\Entity\Appointment;
use App\Domain\Entity\Patient;
use App\Domain\Enum\NotificationType;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Settings\WebUrls;

/**
 * Direct card payment (Paystack) for a consultation, shared by booking
 * (POST /portal/appointments) and accepting a follow-up proposal: start the
 * hosted checkout for an amount (pay-init), then verify the returned reference
 * server-side before the consultation is booked or confirmed. The appointment
 * itself is only marked paid by the caller once the reference verifies. A
 * payment that can no longer book what it was for is credited to the wallet
 * instead ({@see creditToWallet()}).
 */
final class AppointmentCheckout
{
    /** {@see verify()}'s answer for a payment that is in the wallet already (credited, or a top-up). */
    public const ALREADY_IN_WALLET = 'This payment is already in your wallet — pay from your wallet instead.';

    public function __construct(
        private readonly PaystackService $paystack,
        private readonly PricingService $pricing,
        private readonly AppointmentRepository $appointments,
        private readonly PatientNotifier $patientNotifier,
        private readonly AppointmentPaymentService $payments,
    ) {
    }

    /** The wallet-ledger reference a card payment is credited under when it can't be used — once per payment. */
    public static function walletCreditKey(string $reference): string
    {
        return 'fu_card_credit_' . $reference;
    }

    /**
     * Why a card checkout can't start for this patient and amount, as
     * [status, message, errors], or null when it can. A free consultation has
     * nothing to charge (422 `payment: free`) — checked first, so it never
     * needs a checkout even where card payment isn't set up yet.
     *
     * @return array{0:int, 1:string, 2:array<string,string>}|null
     */
    public function startProblem(Patient $patient, string $amount): ?array
    {
        if ((int) bcmul($amount, '100', 0) <= 0) {
            return [422, 'This consultation is free — no payment is needed.', ['payment' => 'free']];
        }
        if (!$this->paystack->isConfigured()) {
            return [503, 'Card payment is not available yet', []];
        }
        if (self::isUnusableEmail(trim($patient->getEmail()))) {
            return [
                422,
                'Add a valid email address to your profile before paying by card.',
                ['email' => 'A real, deliverable email is required for payments.'],
            ];
        }

        return null;
    }

    /**
     * Start the hosted checkout (call {@see startProblem()} first). The patient
     * returns to `$returnPath` on their own site.
     *
     * @param array<string,mixed> $metadata
     * @return array{authorization_url:string, access_code:string, reference:string, amount:string, currency:string}
     * @throws \Throwable when Paystack refuses (the caller answers 502)
     */
    public function initialize(Patient $patient, string $amount, string $returnPath, array $metadata): array
    {
        $reference = 'vma_' . bin2hex(random_bytes(12));
        $currency  = $this->pricing->currency();
        $base      = WebUrls::requestPatientOrigin() ?? WebUrls::patientDefault();

        $init = $this->paystack->initialize(
            trim($patient->getEmail()),
            (int) bcmul($amount, '100', 0),
            $currency,
            $reference,
            $base . $returnPath,
            ['patient_id' => $patient->getId()] + $metadata,
        );

        return [
            'authorization_url' => $init['authorization_url'],
            'access_code'       => $init['access_code'],
            'reference'         => $reference,
            'amount'            => $amount,
            'currency'          => $currency,
        ];
    }

    /**
     * Server-side verification of a direct card payment before it can book or
     * confirm a consultation. Returns a user-safe error string, or null when the
     * payment is valid: it must be a fresh (unused) Paystack reference whose
     * transaction succeeded, in the right currency, for at least the
     * appointment amount (or `$amount`, a price not stored on it yet). Unused
     * means: not on a booking, not already credited to the wallet, and not a
     * wallet top-up (that money is in the wallet already).
     */
    public function verify(string $reference, Appointment $appointment, ?string $amount = null): ?string
    {
        if ($this->appointments->existsByPaymentReference($reference)) {
            return 'This payment has already been used for a booking.';
        }
        if ($this->payments->isPosted(self::walletCreditKey($reference)) || $this->payments->isPosted($reference)) {
            return self::ALREADY_IN_WALLET;
        }
        try {
            $tx = $this->paystack->verify($reference);
        } catch (\Throwable $e) {
            error_log('[appointments.checkout] card verify failed: ' . $e->getMessage());

            return 'We could not verify your card payment. Please try again.';
        }
        if ($tx['status'] !== 'success') {
            return 'Your card payment was not completed.';
        }
        if ($tx['currency'] !== strtoupper($this->pricing->currency())) {
            return 'The payment currency does not match. Please contact support.';
        }
        $expectedMinor = (int) bcmul($amount ?? $appointment->getAmount(), '100', 0);
        if ($tx['amount_minor'] < $expectedMinor) {
            return 'The amount paid does not cover this consultation.';
        }

        return null;
    }

    /**
     * Credit a card payment that can no longer book what it was for (a
     * follow-up that closed, or whose slot or doctor went, while the patient
     * paid) to the patient's wallet, for the amount actually paid. Once per
     * reference ({@see walletCreditKey()}), and {@see verify()} then refuses
     * it, so the same payment can't also book. Returns the amount credited, or
     * null when there is nothing to credit: not paid, already used for a
     * booking, or a wallet top-up.
     */
    public function creditToWallet(string $reference, Appointment $appointment): ?string
    {
        if ($this->appointments->existsByPaymentReference($reference) || $this->payments->isPosted($reference)) {
            return null;
        }
        try {
            $tx = $this->paystack->verify($reference);
        } catch (\Throwable $e) {
            error_log('[appointments.checkout] card verify for a wallet credit failed: ' . $e->getMessage());

            return null;
        }
        if ($tx['status'] !== 'success' || $tx['currency'] !== strtoupper($this->pricing->currency()) || $tx['amount_minor'] <= 0) {
            return null;
        }
        $amount = bcdiv((string) $tx['amount_minor'], '100', 2);
        $this->payments->creditBack($appointment, $amount, self::walletCreditKey($reference));

        return $amount;
    }

    /** In-app "payment received" notice once a card-paid consultation is stored. */
    public function notifyCardPayment(Appointment $appointment): void
    {
        $currency = $this->pricing->currency() === 'NGN' ? '₦' : $this->pricing->currency();
        $this->patientNotifier->notify(
            $appointment->getPatient(),
            NotificationType::PAYMENT,
            'Payment received',
            sprintf(
                'We received your payment of %s%s for your consultation with %s.',
                $currency,
                $appointment->getAmount(),
                $appointment->getSpecialist()->getName(),
            ),
        );
    }

    /** A placeholder or undeliverable address Paystack would bounce. */
    public static function isUnusableEmail(string $email): bool
    {
        if ($email === '' || filter_var($email, FILTER_VALIDATE_EMAIL) === false) {
            return true;
        }
        $domain = strtolower((string) substr((string) strrchr($email, '@'), 1));
        $tld    = (string) strrchr($domain, '.');

        return in_array($tld, ['.test', '.example', '.invalid', '.localhost', '.local'], true);
    }
}
