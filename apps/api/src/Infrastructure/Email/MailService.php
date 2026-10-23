<?php

declare(strict_types=1);

namespace App\Infrastructure\Email;

use Psr\Log\LoggerInterface;

/**
 * Transactional email via ZeptoMail. Deliberately fire-and-forget: send() never
 * throws into the request flow — a mail hiccup must not fail a booking. When
 * unconfigured (no token) it logs and no-ops, so nothing is sent in dev/tests.
 *
 * Logs are PHI-free (spec §3.7): a line carries only `to_hash` (the first 12
 * hex of the sha256 of the lower-cased address), the HTTP code when there is
 * one and the template key — never the address, the subject (reviewer
 * subjects hold a name), the response body or an exception's message.
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

    /** The recipient as logs show it: a short hash, never the address. */
    public static function toHash(string $address): string
    {
        return substr(hash('sha256', strtolower(trim($address))), 0, 12);
    }

    /** Returns true only when ZeptoMail accepted the message. `$template` names it in the logs. */
    public function send(string $toAddress, string $toName, string $subject, string $htmlBody, string $template = 'unknown'): bool
    {
        if (!$this->isConfigured()) {
            $this->logger->info('Email skipped — ZeptoMail not configured', [
                'to_hash'  => self::toHash($toAddress),
                'template' => $template,
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
                    'to_hash'  => self::toHash($toAddress),
                    'code'     => $code,
                    'template' => $template,
                ]);

                return false;
            }

            return true;
        } catch (\Throwable $e) {
            $this->logger->error('Email send threw', [
                'to_hash'  => self::toHash($toAddress),
                'error'    => $e::class,
                'template' => $template,
            ]);

            return false;
        }
    }
}
