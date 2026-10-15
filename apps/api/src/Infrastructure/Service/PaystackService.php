<?php

declare(strict_types=1);

namespace App\Infrastructure\Service;

/**
 * Paystack payments — wallet funding fulfillment. Server-side only: we initialise
 * a transaction (returns a hosted checkout URL), verify it after the redirect, and
 * accept a signed webhook as a backstop. The secret key never leaves the backend.
 * Unconfigured (no secret key) => isConfigured() false and callers return 503.
 *
 * @see https://paystack.com/docs/api/transaction
 */
final class PaystackService
{
    public function __construct(
        private readonly string $secretKey,
        private readonly string $publicKey,
        private readonly string $baseUrl,
    ) {
    }

    public function isConfigured(): bool
    {
        return $this->secretKey !== '';
    }

    public function publicKey(): string
    {
        return $this->publicKey;
    }

    /**
     * Initialise a transaction; returns the hosted checkout URL + reference.
     *
     * @param array<string,mixed> $metadata
     * @return array{authorization_url:string, access_code:string, reference:string}
     */
    public function initialize(
        string $email,
        int $amountMinor,
        string $currency,
        string $reference,
        string $callbackUrl,
        array $metadata = [],
    ): array {
        $res = $this->request('POST', '/transaction/initialize', [
            'email'        => $email,
            'amount'       => $amountMinor,
            'currency'     => strtoupper($currency),
            'reference'    => $reference,
            'callback_url' => $callbackUrl,
            'metadata'     => $metadata,
        ]);

        $data = $res['data'] ?? [];
        if (!is_array($data) || !is_string($data['authorization_url'] ?? null)) {
            throw new \RuntimeException('Could not start the payment');
        }

        return [
            'authorization_url' => $data['authorization_url'],
            'access_code'       => (string) ($data['access_code'] ?? ''),
            'reference'         => (string) ($data['reference'] ?? $reference),
        ];
    }

    /**
     * Verify a transaction by reference.
     *
     * `amount_minor` is what was paid TO US ({@see paidAmountMinor()}): when the
     * Paystack business passes its charges on to the customer, `data.amount` is
     * the amount we initialised PLUS Paystack's fee — that fee is Paystack's,
     * never money to credit or count as an overpayment. The raw figures are
     * kept alongside: `gross_amount_minor` (data.amount), `fees_minor`,
     * `requested_amount_minor`.
     *
     * @return array{status:string, amount_minor:int, currency:string, reference:string, gateway_reference:?string, gross_amount_minor:int, fees_minor:?int, requested_amount_minor:?int, metadata:array<string,mixed>, paid_at:?string}
     */
    public function verify(string $reference): array
    {
        $res  = $this->request('GET', '/transaction/verify/' . rawurlencode($reference));
        $data = $res['data'] ?? [];
        if (!is_array($data)) {
            throw new \RuntimeException('Could not verify the payment');
        }

        return [
            'status'                 => (string) ($data['status'] ?? 'failed'),
            'amount_minor'           => self::paidAmountMinor($data),
            'currency'               => strtoupper((string) ($data['currency'] ?? '')),
            'reference'              => (string) ($data['reference'] ?? $reference),
            'gateway_reference'      => isset($data['id']) ? (string) $data['id'] : null,
            'gross_amount_minor'     => self::minorField($data['amount'] ?? null) ?? 0,
            'fees_minor'             => self::minorField($data['fees'] ?? null),
            'requested_amount_minor' => self::minorField($data['requested_amount'] ?? null),
            // Card payments (PaymentIntentService) also read what the checkout
            // recorded with Paystack, and when it was paid.
            'metadata'               => self::metadataOf($data['metadata'] ?? null),
            'paid_at'                => is_string($data['paid_at'] ?? $data['paidAt'] ?? null) ? (string) ($data['paid_at'] ?? $data['paidAt']) : null,
        ];
    }

    /**
     * The checkout's `metadata` as an array — Paystack returns the object we
     * sent, or (for some integrations) that object as a JSON string.
     *
     * @return array<string,mixed>
     */
    private static function metadataOf(mixed $metadata): array
    {
        if (is_string($metadata) && $metadata !== '') {
            $metadata = json_decode($metadata, true);
        }

        return is_array($metadata) ? $metadata : [];
    }

    /**
     * The amount (minor units) a verified Paystack transaction paid to us:
     * `requested_amount` — what we initialised — when the charge covers it
     * (equal when we bear the fee; `amount` = requested + fee when the customer
     * bears it), otherwise the charged `amount` (no `requested_amount`, or a
     * charge below it — which then never matches what was expected). Never
     * more than was actually charged.
     *
     * @param array<string,mixed> $data Paystack's verify `data` object
     */
    public static function paidAmountMinor(array $data): int
    {
        $charged   = self::minorField($data['amount'] ?? null) ?? 0;
        $requested = self::minorField($data['requested_amount'] ?? null);
        if ($requested !== null && $requested > 0 && $requested <= $charged) {
            return $requested;
        }

        return $charged;
    }

    /** A non-negative whole number of minor units from Paystack's JSON, or null. */
    private static function minorField(mixed $value): ?int
    {
        if (is_int($value)) {
            return $value >= 0 ? $value : null;
        }
        if (is_string($value) && preg_match('/^\d{1,18}$/', trim($value)) === 1) {
            return (int) trim($value);
        }
        if (is_float($value) && $value >= 0 && $value < 1e18 && floor($value) === $value) {
            return (int) $value;
        }

        return null;
    }

    /** Constant-time check of the x-paystack-signature header (HMAC-SHA512). */
    public function verifySignature(string $rawBody, string $signature): bool
    {
        if (!$this->isConfigured() || $signature === '') {
            return false;
        }

        return hash_equals(hash_hmac('sha512', $rawBody, $this->secretKey), $signature);
    }

    /**
     * @param array<string,mixed>|null $body
     * @return array<string,mixed>
     */
    private function request(string $method, string $path, ?array $body = null): array
    {
        if (!$this->isConfigured()) {
            throw new \RuntimeException('Payments are not configured');
        }

        $ch = curl_init(rtrim($this->baseUrl, '/') . $path);
        if ($ch === false) {
            throw new \RuntimeException('Payment service unreachable');
        }
        $opts = [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CUSTOMREQUEST  => $method,
            CURLOPT_HTTPHEADER     => [
                'Authorization: Bearer ' . $this->secretKey,
                'Content-Type: application/json',
                'Cache-Control: no-cache',
            ],
            CURLOPT_TIMEOUT        => 20,
            CURLOPT_CONNECTTIMEOUT => 8,
        ];
        if ($body !== null) {
            $opts[CURLOPT_POSTFIELDS] = json_encode($body);
        }
        curl_setopt_array($ch, $opts);
        $raw    = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);

        if (!is_string($raw)) {
            throw new \RuntimeException('Payment service unreachable');
        }
        $json = json_decode($raw, true);
        if (!is_array($json)) {
            throw new \RuntimeException('Unexpected payment service response');
        }
        if ($status >= 400 || ($json['status'] ?? false) === false) {
            $message = is_string($json['message'] ?? null) ? $json['message'] : 'payment request failed';
            throw new \RuntimeException('Paystack: ' . $message);
        }

        return $json;
    }
}
