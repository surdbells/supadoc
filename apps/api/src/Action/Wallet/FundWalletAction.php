<?php

declare(strict_types=1);

namespace App\Action\Wallet;

use App\Domain\Entity\Patient;
use App\Domain\Repository\PatientRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\AuditLogger;
use App\Infrastructure\Service\PaystackService;
use App\Infrastructure\Service\WalletService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/portal/wallet/fund — start a wallet top-up. Creates a pending ledger
 * entry and initialises a Paystack transaction; returns the hosted checkout URL.
 * The credit only happens once the payment is verified (client verify + webhook).
 */
final class FundWalletAction
{
    use ApiResponse;

    public function __construct(
        private readonly PatientRepository $patients,
        private readonly WalletService $wallets,
        private readonly PaystackService $paystack,
        private readonly AuditLogger $audit,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        if (!$this->paystack->isConfigured()) {
            return $this->error($response, 'Wallet funding is not available yet', 503);
        }

        $customerId = (string) $request->getAttribute('customer_id');
        /** @var Patient $patient */
        $patient = $this->patients->findOrFail($customerId);

        // Paystack requires a real, deliverable customer email (it rejects blank,
        // malformed, or reserved-TLD addresses like `@…​.test`). Catch it here so
        // the patient gets an actionable 422 instead of a downstream 502.
        $email = trim($patient->getEmail());
        if ($this->isUnusableEmail($email)) {
            return $this->error(
                $response,
                'Add a valid email address to your profile before funding your wallet.',
                422,
                ['email' => 'A real, deliverable email is required for payments.'],
            );
        }

        $body     = (array) ($request->getParsedBody() ?? []);
        $currency = strtoupper((string) ($body['currency'] ?? $this->wallets->defaultCurrency()));
        if (!$this->wallets->isSupported($currency)) {
            return $this->error($response, 'Unsupported currency', 422, ['currency' => 'Unsupported currency']);
        }

        try {
            $amount = $this->wallets->normalise((string) ($body['amount'] ?? ''));
        } catch (\InvalidArgumentException $e) {
            return $this->error($response, $e->getMessage(), 422, ['amount' => $e->getMessage()]);
        }

        $reference = 'vmw_' . bin2hex(random_bytes(12));
        $this->wallets->beginTopup($customerId, $currency, $amount, $reference);

        $base        = rtrim((string) ($_ENV['APP_WEB_URL'] ?? 'http://localhost:4201'), '/');
        $callbackUrl = $base . '/dashboard/wallet';

        try {
            $init = $this->paystack->initialize(
                $email,
                $this->wallets->toMinor($amount),
                $currency,
                $reference,
                $callbackUrl,
                ['patient_id' => $customerId, 'purpose' => 'wallet_topup'],
            );
        } catch (\RuntimeException $e) {
            $this->wallets->failTopup($reference);
            // Surface the real cause in the server log (the client only gets a
            // generic message). Run `php bin/paystack-check.php` to diagnose.
            error_log(sprintf('[wallet.fund] paystack initialize failed (ref=%s): %s', $reference, $e->getMessage()));

            return $this->error($response, 'Could not start the payment. Please try again.', 502);
        }

        $p = $patient->toArray();
        $this->audit->record(
            trim(((string) ($p['first_name'] ?? '')) . ' ' . ((string) ($p['last_name'] ?? ''))),
            'patient',
            'wallet.topup_initiated',
            null,
            'wallet_transaction',
            $reference,
            ['amount' => $amount, 'currency' => $currency],
        );

        return $this->success($response, [
            'authorization_url' => $init['authorization_url'],
            'reference'         => $reference,
            'access_code'       => $init['access_code'],
        ], 'Payment started', 201)->withHeader('Cache-Control', 'no-store');
    }

    /**
     * True if an email can't be used with the payment gateway: blank, malformed,
     * or on an RFC 2606 / mDNS reserved TLD (`.test`, `.example`, `.invalid`,
     * `.localhost`, `.local`) — Paystack rejects all of these as invalid.
     */
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
