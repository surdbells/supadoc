<?php

declare(strict_types=1);

namespace App\Infrastructure\Agora;

use Psr\Log\LoggerInterface;

/**
 * Puts someone out of a consultation channel at once, through Agora's
 * channel-management RESTful API ("kicking rule"): the uid is removed from the
 * channel and can't join it again while the rule lasts, whatever token it
 * holds. Used when a guest is removed or the consultation is cancelled — their
 * link already stopped working, and this ends a session already in progress
 * instead of leaving it until its Agora token expires.
 *
 * Authenticates with the project's Customer ID / Secret (HTTP Basic, as
 * {@see AgoraRecordingService}). Unconfigured => kick() does nothing (logged
 * once); a failure is logged, never thrown — the removal itself stands. Never
 * logs a token or a credential.
 *
 * @see https://docs.agora.io/en/video-calling/reference/channel-management-rest-api
 */
final class AgoraKickingService
{
    private const URL = 'https://api.agora.io/dev/v1/kicking-rule';
    /** Agora's range for a rule's duration, in minutes. */
    private const MIN_MINUTES = 1;
    private const MAX_MINUTES = 1440;

    private bool $warned = false;

    /**
     * @param (\Closure(string $url, list<string> $headers, string $body): array{status:int, body:string})|null $transport
     *        sends the request (tests); null = cURL
     */
    public function __construct(
        private readonly string $appId,
        private readonly string $customerId,
        private readonly string $customerSecret,
        private readonly ?LoggerInterface $logger = null,
        private readonly ?\Closure $transport = null,
    ) {
    }

    public function isConfigured(): bool
    {
        return $this->appId !== '' && $this->customerId !== '' && $this->customerSecret !== '';
    }

    /**
     * Remove `$uid` from `$channel` now and keep it out for `$minutes` (1–1440).
     * True when Agora accepted the rule.
     */
    public function kick(string $channel, int $uid, int $minutes): bool
    {
        if (!$this->isConfigured()) {
            if (!$this->warned) {
                $this->warned = true;
                $this->logger?->warning('Agora kicking is not configured (AGORA_CUSTOMER_ID / AGORA_CUSTOMER_SECRET): a removed guest keeps their call until their token expires.');
            }

            return false;
        }
        if ($channel === '' || $uid <= 0) {
            return false;
        }

        $body = (string) json_encode([
            'appid'      => $this->appId,
            'cname'      => $channel,
            'uid'        => $uid,
            'ip'         => '',
            'time'       => max(self::MIN_MINUTES, min(self::MAX_MINUTES, $minutes)),
            'privileges' => ['join_channel'],
        ]);
        $headers = [
            'Content-Type: application/json',
            'Authorization: Basic ' . base64_encode($this->customerId . ':' . $this->customerSecret),
        ];

        try {
            $res = $this->transport !== null ? ($this->transport)(self::URL, $headers, $body) : $this->send($headers, $body);
        } catch (\Throwable $e) {
            $this->logger?->error('Agora kicking rule failed for uid ' . $uid . ': ' . $e->getMessage());

            return false;
        }
        $json = json_decode($res['body'], true);
        if ($res['status'] >= 400 || !is_array($json) || ($json['status'] ?? null) !== 'success') {
            $reason = is_array($json) && is_string($json['message'] ?? null) ? $json['message'] : 'HTTP ' . $res['status'];
            $this->logger?->error('Agora kicking rule refused for uid ' . $uid . ': ' . $reason);

            return false;
        }

        return true;
    }

    /**
     * @param list<string> $headers
     * @return array{status:int, body:string}
     */
    private function send(array $headers, string $body): array
    {
        $ch = curl_init(self::URL);
        if ($ch === false) {
            throw new \RuntimeException('Agora unreachable');
        }
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CUSTOMREQUEST  => 'POST',
            CURLOPT_HTTPHEADER     => $headers,
            CURLOPT_POSTFIELDS     => $body,
            CURLOPT_TIMEOUT        => 8,
            CURLOPT_CONNECTTIMEOUT => 4,
        ]);
        $raw    = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        if (!is_string($raw)) {
            throw new \RuntimeException('Agora unreachable');
        }

        return ['status' => $status, 'body' => $raw];
    }
}
