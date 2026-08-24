<?php

declare(strict_types=1);

namespace App\Infrastructure\Agora;

/**
 * Mints Agora RTC tokens for consultation channels. Reads the App ID + App
 * Certificate from env; unconfigured => isConfigured() is false and callers
 * should return 503. The certificate never leaves the backend.
 */
final class AgoraTokenService
{
    public function __construct(
        private readonly string $appId,
        private readonly string $appCertificate,
    ) {
    }

    /** Both App ID and certificate present — secured mode; mint real tokens. */
    public function isConfigured(): bool
    {
        return $this->appId !== '' && $this->appCertificate !== '';
    }

    /**
     * App ID present (certificate optional). When true but not isConfigured(),
     * the project runs in App-ID-only mode and clients join with a null token.
     */
    public function hasAppId(): bool
    {
        return $this->appId !== '';
    }

    public function appId(): string
    {
        return $this->appId;
    }

    /** A publisher RTC token for a channel, valid for $ttl seconds. */
    public function rtcToken(string $channel, int $uid = 0, int $ttl = 3600): string
    {
        $token = RtcTokenBuilder2::buildTokenWithUid(
            $this->appId,
            $this->appCertificate,
            $channel,
            $uid,
            RtcTokenBuilder2::ROLE_PUBLISHER,
            $ttl,
            $ttl,
        );

        if ($token === '') {
            // build() returns '' when the App ID / certificate aren't 32-char hex.
            throw new \RuntimeException('Invalid Agora credentials');
        }

        return $token;
    }
}
