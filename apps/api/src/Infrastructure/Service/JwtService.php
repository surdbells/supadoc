<?php

declare(strict_types=1);

namespace App\Infrastructure\Service;

use Firebase\JWT\JWT;
use Firebase\JWT\Key;
use stdClass;

/**
 * Stateless JWT. One signing secret serves several audiences via a `scope`
 * claim (staff / customer / investor); the audience-scoped middleware reject
 * tokens minted for a different scope (see ARCHITECTURE §8). Permissions ride
 * in the token, so a permission change only takes effect at next sign-in.
 */
final class JwtService
{
    private const ALGO = 'HS256';

    public function __construct(
        private readonly string $secret,
        private readonly int $accessTtl,
        private readonly int $refreshTtl,
    ) {
    }

    /**
     * @param list<string> $roles
     * @param list<string> $permissions
     */
    public function issueAccessToken(
        string $subject,
        string $scope,
        array $roles = [],
        array $permissions = [],
        ?string $jti = null,
    ): string {
        $now     = time();
        $payload = [
            'sub'         => $subject,
            'scope'       => $scope,
            'roles'       => array_values($roles),
            'permissions' => array_values($permissions),
            'type'        => 'access',
            'iat'         => $now,
            'exp'         => $now + $this->accessTtl,
        ];
        // A jti ties the token to a revocable server-side session.
        if ($jti !== null) {
            $payload['jti'] = $jti;
        }

        return JWT::encode($payload, $this->secret, self::ALGO);
    }

    public function issueRefreshToken(string $subject, string $scope, ?string $jti = null): string
    {
        $now     = time();
        $payload = [
            'sub'   => $subject,
            'scope' => $scope,
            'type'  => 'refresh',
            'iat'   => $now,
            'exp'   => $now + $this->refreshTtl,
        ];
        // Bind the refresh token to the same revocable session as its access token.
        if ($jti !== null) {
            $payload['jti'] = $jti;
        }

        return JWT::encode($payload, $this->secret, self::ALGO);
    }

    public function validateAccessToken(string $token): stdClass
    {
        $payload = JWT::decode($token, new Key($this->secret, self::ALGO));
        if (($payload->type ?? null) !== 'access') {
            throw new \RuntimeException('Not an access token');
        }

        return $payload;
    }

    public function validateRefreshToken(string $token): stdClass
    {
        $payload = JWT::decode($token, new Key($this->secret, self::ALGO));
        if (($payload->type ?? null) !== 'refresh') {
            throw new \RuntimeException('Not a refresh token');
        }

        return $payload;
    }

    public function accessTtl(): int
    {
        return $this->accessTtl;
    }

    /**
     * Short-lived proof that a phone number was just verified over SMS. The
     * register/login-by-phone endpoints consume it instead of re-checking the
     * (single-use) OTP.
     */
    public function issuePhoneProof(string $phone, int $ttl = 600): string
    {
        $now = time();

        return JWT::encode([
            'phone' => $phone,
            'type'  => 'phone_proof',
            'iat'   => $now,
            'exp'   => $now + $ttl,
        ], $this->secret, self::ALGO);
    }

    /** The verified phone from a valid, unexpired proof token, or null. */
    public function verifyPhoneProof(string $token): ?string
    {
        try {
            $payload = JWT::decode($token, new Key($this->secret, self::ALGO));
        } catch (\Throwable) {
            return null;
        }

        if (($payload->type ?? null) !== 'phone_proof' || empty($payload->phone)) {
            return null;
        }

        return (string) $payload->phone;
    }

    /** Short-lived proof that an email was just verified over an emailed OTP. */
    public function issueEmailProof(string $email, int $ttl = 900): string
    {
        $now = time();

        return JWT::encode([
            'email' => $email,
            'type'  => 'email_proof',
            'iat'   => $now,
            'exp'   => $now + $ttl,
        ], $this->secret, self::ALGO);
    }

    /** The verified email from a valid, unexpired proof token, or null. */
    public function verifyEmailProof(string $token): ?string
    {
        try {
            $payload = JWT::decode($token, new Key($this->secret, self::ALGO));
        } catch (\Throwable) {
            return null;
        }

        if (($payload->type ?? null) !== 'email_proof' || empty($payload->email)) {
            return null;
        }

        return (string) $payload->email;
    }
}
