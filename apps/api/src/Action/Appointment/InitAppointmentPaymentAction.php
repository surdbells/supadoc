<?php

declare(strict_types=1);

namespace App\Action\Appointment;

use App\Domain\Entity\Patient;
use App\Domain\Entity\Specialist;
use App\Domain\Repository\PatientRepository;
use App\Domain\Repository\SpecialistRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\PaystackService;
use App\Infrastructure\Service\PricingService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/portal/appointments/pay-init — start a direct card payment for a
 * consultation (Paystack), so a patient can pay by card instead of funding the
 * wallet. Returns the checkout access code + reference; the booking is created
 * only after the reference verifies (see CreateMyAppointmentAction).
 */
final class InitAppointmentPaymentAction
{
    use ApiResponse;

    private const MAX_GUESTS = 3;

    public function __construct(
        private readonly PatientRepository $patients,
        private readonly SpecialistRepository $specialists,
        private readonly PricingService $pricing,
        private readonly PaystackService $paystack,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        if (!$this->paystack->isConfigured()) {
            return $this->error($response, 'Card payment is not available yet', 503);
        }

        $customerId   = (string) $request->getAttribute('customer_id');
        $body         = (array) ($request->getParsedBody() ?? []);
        $specialistId = trim((string) ($body['specialist_id'] ?? ''));
        $guestCount   = max(0, min(self::MAX_GUESTS, (int) ($body['guest_count'] ?? 0)));

        if ($specialistId === '') {
            return $this->error($response, 'Please choose a specialist', 422, ['specialist_id' => 'Required']);
        }

        /** @var Patient $patient */
        $patient    = $this->patients->findOrFail($customerId);
        /** @var Specialist $specialist */
        $specialist = $this->specialists->findOrFail($specialistId);

        $email = trim($patient->getEmail());
        if ($this->isUnusableEmail($email)) {
            return $this->error(
                $response,
                'Add a valid email address to your profile before paying by card.',
                422,
                ['email' => 'A real, deliverable email is required for payments.'],
            );
        }

        $amount   = $this->totalAmount($specialist, $guestCount);
        $currency = $this->pricing->currency();
        $minor    = (int) bcmul($amount, '100', 0);
        if ($minor <= 0) {
            return $this->error($response, 'This consultation has no payable amount.', 422);
        }

        $reference = 'vma_' . bin2hex(random_bytes(12));
        $base      = rtrim((string) ($_ENV['APP_WEB_URL'] ?? 'http://localhost:4201'), '/');

        try {
            $init = $this->paystack->initialize(
                $email,
                $minor,
                $currency,
                $reference,
                $base . '/dashboard/appointments',
                ['patient_id' => $customerId, 'specialist_id' => $specialistId, 'purpose' => 'appointment_booking'],
            );
        } catch (\Throwable $e) {
            error_log('[appointments.pay-init] paystack initialize failed: ' . $e->getMessage());

            return $this->error($response, 'Could not start the payment. Please try again.', 502);
        }

        return $this->created($response, [
            'authorization_url' => $init['authorization_url'],
            'access_code'       => $init['access_code'],
            'reference'         => $reference,
            'amount'            => $amount,
            'currency'          => $currency,
        ], 'Payment started')->withHeader('Cache-Control', 'no-store');
    }

    private function totalAmount(Specialist $specialist, int $guestCount): string
    {
        $guestFee = number_format($this->pricing->guestFee(), 2, '.', '');

        return bcadd($specialist->getConsultationFee(), bcmul($guestFee, (string) $guestCount, 2), 2);
    }

    private function isUnusableEmail(string $email): bool
    {
        if ($email === '' || filter_var($email, FILTER_VALIDATE_EMAIL) === false) {
            return true;
        }
        $domain = strtolower((string) substr((string) strrchr($email, '@'), 1));
        $tld    = (string) strrchr($domain, '.');

        return in_array($tld, ['.test', '.example', '.invalid', '.localhost', '.local'], true);
    }
}
