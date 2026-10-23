<?php

declare(strict_types=1);

namespace App\Infrastructure\Service;

use Psr\Log\LoggerInterface;

/**
 * Phone verification via Termii's OTP API. `sendOtp` triggers an SMS PIN and
 * returns Termii's `pinId`; `verifyOtp` checks a submitted code against it.
 * Termii holds the PIN, so we never store or see the code. Unconfigured (no API
 * key) => isConfigured() is false and callers should short-circuit.
 *
 * {@see send()} is a plain text message (doctor-application status updates and
 * codes, spec D8) on `$smsChannel` (TERMII_SMS_CHANNEL, default generic).
 */
final class TermiiService
{
    /**
     * @param (\Closure(string $url, array<string,mixed> $body): array{code:int, body:string})|null $transport
     *        the HTTP call (tests inject one); null = curl
     */
    public function __construct(
        private readonly string $apiKey,
        private readonly string $senderId,
        private readonly string $baseUrl,
        private readonly string $smsChannel = 'generic',
        private readonly ?\Closure $transport = null,
        private readonly ?LoggerInterface $logger = null,
    ) {
    }

    public function isConfigured(): bool
    {
        return $this->apiKey !== '';
    }

    /**
     * A plain SMS (Termii /api/sms/send). True only on a 2xx carrying a
     * `message_id`. Never throws; logs only the HTTP code and a hash of the
     * recipient — never the number, the text or the response body.
     */
    public function send(string $toE164, string $text): bool
    {
        if (!$this->isConfigured()) {
            return false;
        }
        $toHash = substr(hash('sha256', $toE164), 0, 12);
        try {
            $res = ($this->transport ?? $this->curlTransport(...))(rtrim($this->baseUrl, '/') . '/api/sms/send', [
                'api_key' => $this->apiKey,
                'to'      => ltrim($toE164, '+'),
                'from'    => $this->senderId !== '' ? $this->senderId : 'VideoMed',
                'sms'     => $text,
                'type'    => 'plain',
                'channel' => $this->smsChannel !== '' ? $this->smsChannel : 'generic',
            ]);
            $json = json_decode((string) ($res['body'] ?? ''), true);
            $ok   = ($res['code'] ?? 0) >= 200 && ($res['code'] ?? 0) < 300 && is_array($json) && ($json['message_id'] ?? '') !== '';
            if (!$ok) {
                $this->logger?->warning('SMS send failed', ['to_hash' => $toHash, 'code' => (int) ($res['code'] ?? 0)]);
            }

            return $ok;
        } catch (\Throwable $e) {
            $this->logger?->warning('SMS send threw', ['to_hash' => $toHash, 'error' => $e::class]);

            return false;
        }
    }

    /**
     * @param array<string,mixed> $body
     * @return array{code:int, body:string}
     */
    private function curlTransport(string $url, array $body): array
    {
        $ch = curl_init($url);
        if ($ch === false) {
            return ['code' => 0, 'body' => ''];
        }
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_POST           => true,
            CURLOPT_HTTPHEADER     => ['Content-Type: application/json'],
            CURLOPT_POSTFIELDS     => json_encode($body),
            CURLOPT_TIMEOUT        => 10,
            CURLOPT_CONNECTTIMEOUT => 5,
        ]);
        $raw  = curl_exec($ch);
        $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);

        return ['code' => $code, 'body' => is_string($raw) ? $raw : ''];
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
