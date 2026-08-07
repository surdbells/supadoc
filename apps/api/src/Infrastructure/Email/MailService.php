<?php

declare(strict_types=1);

namespace App\Infrastructure\Email;

use Psr\Log\LoggerInterface;

/**
 * Transactional email via ZeptoMail. Deliberately fire-and-forget: send() never
 * throws into the request flow — a mail hiccup must not fail a booking. When
 * unconfigured (no token) it logs and no-ops, so nothing is sent in dev/tests.
 */
final class MailService
{
    public function __construct(
        private readonly string $token,
        private readonly string $fromAddress,
        private readonly string $fromName,
        private readonly string $baseUrl,
        private readonly LoggerInterface $logger,
    ) {
    }

    public function isConfigured(): bool
    {
        return $this->token !== '' && $this->fromAddress !== '';
    }

    /** Returns true only when ZeptoMail accepted the message. */
    public function send(string $toAddress, string $toName, string $subject, string $htmlBody): bool
    {
        if (!$this->isConfigured()) {
            $this->logger->info('Email skipped — ZeptoMail not configured', [
                'to'      => $toAddress,
                'subject' => $subject,
            ]);

            return false;
        }

        try {
            $payload = json_encode([
                'from'     => [
                    'address' => $this->fromAddress,
                    'name'    => $this->fromName !== '' ? $this->fromName : 'VideoMed',
                ],
                'to'       => [[
                    'email_address' => ['address' => $toAddress, 'name' => $toName],
                ]],
                'subject'  => $subject,
                'htmlbody' => $htmlBody,
            ], JSON_UNESCAPED_SLASHES);

            $ch = curl_init(rtrim($this->baseUrl, '/') . '/v1.1/email');
            if ($ch === false) {
                return false;
            }
            curl_setopt_array($ch, [
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_POST           => true,
                CURLOPT_HTTPHEADER     => [
                    'Content-Type: application/json',
                    'Accept: application/json',
                    'Authorization: Zoho-enczapikey ' . $this->token,
                ],
                CURLOPT_POSTFIELDS     => $payload,
                CURLOPT_TIMEOUT        => 10,
                CURLOPT_CONNECTTIMEOUT => 5,
            ]);
            $body = curl_exec($ch);
            $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
            curl_close($ch);

            if (!is_string($body) || $code < 200 || $code >= 300) {
                $this->logger->error('Email send failed', [
                    'to'   => $toAddress,
                    'code' => $code,
                    'body' => is_string($body) ? substr($body, 0, 500) : null,
                ]);

                return false;
            }

            return true;
        } catch (\Throwable $e) {
            $this->logger->error('Email send threw', [
                'to'    => $toAddress,
                'error' => $e->getMessage(),
            ]);

            return false;
        }
    }
}
