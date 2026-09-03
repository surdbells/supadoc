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
     * @return array{status:string, amount_minor:int, currency:string, reference:string, gateway_reference:?string}
     */
    public function verify(string $reference): array
    {
        $res  = $this->request('GET', '/transaction/verify/' . rawurlencode($reference));
        $data = $res['data'] ?? [];
        if (!is_array($data)) {
            throw new \RuntimeException('Could not verify the payment');
        }

        return [
            'status'            => (string) ($data['status'] ?? 'failed'),
            'amount_minor'      => (int) ($data['amount'] ?? 0),
            'currency'          => strtoupper((string) ($data['currency'] ?? '')),
            'reference'         => (string) ($data['reference'] ?? $reference),
            'gateway_reference' => isset($data['id']) ? (string) $data['id'] : null,
        ];
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
