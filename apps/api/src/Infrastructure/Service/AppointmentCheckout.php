<?php

declare(strict_types=1);

namespace App\Infrastructure\Service;

use App\Domain\Entity\Appointment;
use App\Domain\Entity\Patient;
use App\Domain\Enum\NotificationType;
use App\Domain\Settings\WebUrls;

/**
 * Starting a direct card payment (Paystack) for a consultation, a follow-up
 * acceptance or a guest: every checkout is first recorded as a
 * {@see \App\Domain\Entity\PaymentIntent} (who pays, for what, how much), so no
 * reference is ever handed to Paystack without a server-side record. Using the
 * payment is {@see PaymentIntentService::consume()} — atomically, once, in the
 * same transaction as what it pays for; an unused one ends up in the wallet
 * ({@see PaymentIntentService::settleUnused()}, the webhook and the sweep).
 */
final class AppointmentCheckout
{
    /** A payment that is in the wallet already (credited, or a top-up). */
    public const ALREADY_IN_WALLET = PaymentIntentService::ALREADY_IN_WALLET;

    public function __construct(
        private readonly PaystackService $paystack,
        private readonly PricingService $pricing,
        private readonly PatientNotifier $patientNotifier,
        private readonly PaymentIntentService $intents,
    ) {
    }

    /** The wallet-ledger reference a card payment is credited under when it can't be used — once per payment. */
    public static function walletCreditKey(string $reference): string
    {
        return PaymentIntentService::walletCreditKey($reference);
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
     * Record the checkout (`$purpose` + `$context`: what it pays for), then
     * start it with Paystack (call {@see startProblem()} first). The patient
     * returns to `$returnPath` on their own site.
     *
     * @param array<string,mixed> $context
     * @return array{authorization_url:string, access_code:string, reference:string, amount:string, currency:string}
     * @throws \Throwable when Paystack refuses (the caller answers 502; the intent is marked failed)
     */
    public function initialize(Patient $patient, string $amount, string $returnPath, string $purpose, array $context): array
    {
        $currency = $this->pricing->currency();
        $intent   = $this->intents->create($patient->getId(), $purpose, $context, $amount, $currency);
        $base     = WebUrls::requestPatientOrigin() ?? WebUrls::patientDefault();

        $metadata = ['patient_id' => $patient->getId(), 'purpose' => $purpose, 'intent_id' => $intent->getId()];
        foreach (['specialist_id', 'appointment_id', 'parent_appointment_id'] as $key) {
            if (($value = $intent->contextValue($key)) !== null) {
                $metadata[$key] = $value;
            }
        }

        try {
            $init = $this->paystack->initialize(
                trim($patient->getEmail()),
                (int) bcmul($intent->getAmount(), '100', 0),
                $currency,
                $intent->getReference(),
                $base . $returnPath,
                $metadata,
            );
        } catch (\Throwable $e) {
            $this->intents->markInitFailed($intent, $e->getMessage());
            throw $e;
        }

        return [
            'authorization_url' => $init['authorization_url'],
            'access_code'       => $init['access_code'],
            'reference'         => $intent->getReference(),
            'amount'            => $intent->getAmount(),
            'currency'          => $currency,
        ];
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
