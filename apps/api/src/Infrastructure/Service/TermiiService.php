<?php

declare(strict_types=1);

namespace App\Infrastructure\Service;

/**
 * Phone verification via Termii's OTP API. `sendOtp` triggers an SMS PIN and
 * returns Termii's `pinId`; `verifyOtp` checks a submitted code against it.
 * Termii holds the PIN, so we never store or see the code. Unconfigured (no API
 * key) => isConfigured() is false and callers should short-circuit.
 */
final class TermiiService
{
    public function __construct(
        private readonly string $apiKey,
        private readonly string $senderId,
        private readonly string $baseUrl,
    ) {
    }

    public function isConfigured(): bool
    {
        return $this->apiKey !== '';
    }

    /** Sends an OTP SMS and returns Termii's pin id. */
    public function sendOtp(string $phone): string
    {
        $res = $this->post('/api/sms/otp/send', [
            'api_key'          => $this->apiKey,
            'message_type'     => 'NUMERIC',
            'to'               => $phone,
            'from'             => $this->senderId !== '' ? $this->senderId : 'Termii',
            'channel'          => 'generic',
            'pin_attempts'     => 3,
            'pin_time_to_live' => 10,
            'pin_length'       => 6,
            'pin_placeholder'  => '< 1234 >',
            'message_text'     => 'Your VideoMed verification code is < 1234 >. It expires in 10 minutes.',
            'pin_type'         => 'NUMERIC',
        ]);

        $pinId = $res['pinId'] ?? null;
        if (!is_string($pinId) || $pinId === '') {
            throw new \RuntimeException('Could not send the verification code');
        }

        return $pinId;
    }

    /** Verifies a code; returns the verified phone (msisdn) on success, else null. */
    public function verifyOtp(string $pinId, string $otp): ?string
    {
        $res      = $this->post('/api/sms/otp/verify', [
            'api_key' => $this->apiKey,
            'pin_id'  => $pinId,
            'pin'     => $otp,
        ]);
        $verified = $res['verified'] ?? false;
        if ($verified !== true && $verified !== 'true') {
            return null;
        }

        return isset($res['msisdn']) ? (string) $res['msisdn'] : '';
    }

    /**
     * @param array<string, mixed> $body
     * @return array<string, mixed>
     */
    private function post(string $path, array $body): array
    {
        if (!$this->isConfigured()) {
            throw new \RuntimeException('Phone verification is not configured');
        }

        $ch = curl_init(rtrim($this->baseUrl, '/') . $path);
        if ($ch === false) {
            throw new \RuntimeException('SMS service unreachable');
        }
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_POST           => true,
            CURLOPT_HTTPHEADER     => ['Content-Type: application/json'],
            CURLOPT_POSTFIELDS     => json_encode($body),
            CURLOPT_TIMEOUT        => 10,
            CURLOPT_CONNECTTIMEOUT => 5,
        ]);
        $raw = curl_exec($ch);
        curl_close($ch);

        if (!is_string($raw)) {
            throw new \RuntimeException('SMS service unreachable');
        }
        $json = json_decode($raw, true);
        if (!is_array($json)) {
            throw new \RuntimeException('Unexpected SMS service response');
        }

        return $json;
    }
}
