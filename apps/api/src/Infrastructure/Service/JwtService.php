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
    ): string {
        $now = time();

        return JWT::encode([
            'sub'         => $subject,
            'scope'       => $scope,
            'roles'       => array_values($roles),
            'permissions' => array_values($permissions),
            'type'        => 'access',
            'iat'         => $now,
            'exp'         => $now + $this->accessTtl,
        ], $this->secret, self::ALGO);
    }

    public function issueRefreshToken(string $subject, string $scope): string
    {
        $now = time();

        return JWT::encode([
            'sub'   => $subject,
            'scope' => $scope,
            'type'  => 'refresh',
            'iat'   => $now,
            'exp'   => $now + $this->refreshTtl,
        ], $this->secret, self::ALGO);
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
}
