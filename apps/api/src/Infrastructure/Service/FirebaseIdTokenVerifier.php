<?php

declare(strict_types=1);

namespace App\Infrastructure\Service;

use App\Domain\Exception\AuthenticationException;
use Firebase\JWT\JWT;
use Firebase\JWT\Key;

/**
 * Verifies a Firebase ID token (the JWT the Firebase Web SDK returns after a
 * Google sign-in) without any service-account secret: the token is RS256-signed
 * by Google, so we fetch Google's public x509 certs and check the signature,
 * issuer, audience and expiry against our Firebase project id.
 *
 * @phpstan-type Identity array{sub: string, email: ?string, name: ?string, email_verified: bool}
 */
final class FirebaseIdTokenVerifier
{
    private const CERTS_URL =
        'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

    public function __construct(private readonly string $projectId)
    {
    }

    /** @return Identity */
    public function verify(string $idToken): array
    {
        if ($this->projectId === '') {
            throw new AuthenticationException('Google sign-in is not configured');
        }

        JWT::$leeway = 60;
        try {
            $payload = JWT::decode($idToken, $this->publicKeys());
        } catch (\Throwable) {
            throw new AuthenticationException('Invalid Google token');
        }

        $issuer = 'https://securetoken.google.com/' . $this->projectId;
        if (
            ($payload->aud ?? null) !== $this->projectId
            || ($payload->iss ?? null) !== $issuer
            || empty($payload->sub)
        ) {
            throw new AuthenticationException('Invalid Google token');
        }

        return [
            'sub'            => (string) $payload->sub,
            'email'          => isset($payload->email) ? (string) $payload->email : null,
            'name'           => isset($payload->name) ? (string) $payload->name : null,
            'email_verified' => (bool) ($payload->email_verified ?? false),
        ];
    }

    /**
     * Google's current signing certs, keyed by `kid` — firebase/php-jwt matches
     * the token's kid against this map.
     *
     * @return array<string, Key>
     */
    private function publicKeys(): array
    {
        $json  = $this->fetch(self::CERTS_URL);
        $certs = $json !== null ? json_decode($json, true) : null;
        if (!is_array($certs) || $certs === []) {
            throw new AuthenticationException('Could not verify Google token right now');
        }

        $keys = [];
        foreach ($certs as $kid => $pem) {
            if (is_string($kid) && is_string($pem)) {
                $keys[$kid] = new Key($pem, 'RS256');
            }
        }

        return $keys;
    }

    private function fetch(string $url): ?string
    {
        $ch = curl_init($url);
        if ($ch === false) {
            return null;
        }
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => 5,
            CURLOPT_CONNECTTIMEOUT => 5,
        ]);
        $body = curl_exec($ch);
        $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);

        return (is_string($body) && $code === 200) ? $body : null;
    }
}
