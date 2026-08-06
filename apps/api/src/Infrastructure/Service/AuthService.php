<?php

declare(strict_types=1);

namespace App\Infrastructure\Service;

use App\Domain\Exception\AuthenticationException;
use App\Domain\Repository\PatientRepository;
use App\Domain\Repository\UserRepository;

/**
 * Authentication behaviour. Keeps password verification and token issuance out
 * of the Actions — an Action just calls `loginStaff()` and shapes the response.
 */
final class AuthService
{
    public function __construct(
        private readonly UserRepository $users,
        private readonly PatientRepository $patients,
        private readonly JwtService $jwt,
    ) {
    }

    /** @return array{access_token:string, refresh_token:string, user:array} */
    public function loginStaff(string $email, string $password): array
    {
        $user = $this->users->findByEmail(strtolower(trim($email)));
        if ($user === null || !$user->verifyPassword($password)) {
            throw new AuthenticationException('Invalid email or password');
        }

        return [
            'access_token'  => $this->jwt->issueAccessToken(
                $user->getId(),
                'staff',
                $user->getRoles(),
                $user->getPermissions(),
            ),
            'refresh_token' => $this->jwt->issueRefreshToken($user->getId(), 'staff'),
            'token_type'    => 'Bearer',
            'expires_in'    => $this->jwt->accessTtl(),
            'user'          => $user->toArray(),
        ];
    }

    /** @return array{access_token:string, refresh_token:string, user:array} */
    public function loginCustomer(string $email, string $password): array
    {
        $patient = $this->patients->findByEmail(strtolower(trim($email)));
        if ($patient === null || !$patient->verifyPassword($password)) {
            throw new AuthenticationException('Invalid email or password');
        }

        return [
            'access_token'  => $this->jwt->issueAccessToken($patient->getId(), 'customer'),
            'refresh_token' => $this->jwt->issueRefreshToken($patient->getId(), 'customer'),
            'token_type'    => 'Bearer',
            'expires_in'    => $this->jwt->accessTtl(),
            'user'          => $patient->toArray(),
        ];
    }

    /** @return array{access_token:string, token_type:string, expires_in:int} */
    public function refresh(string $refreshToken): array
    {
        try {
            $payload = $this->jwt->validateRefreshToken($refreshToken);
        } catch (\Throwable) {
            throw new AuthenticationException('Invalid refresh token');
        }

        $scope = $payload->scope ?? 'staff';
        if ($scope === 'staff') {
            $user = $this->users->find($payload->sub);
            if ($user === null) {
                throw new AuthenticationException('Account no longer exists');
            }
            $access = $this->jwt->issueAccessToken(
                $user->getId(),
                'staff',
                $user->getRoles(),
                $user->getPermissions(),
            );
        } else {
            $patient = $this->patients->find($payload->sub);
            if ($patient === null) {
                throw new AuthenticationException('Account no longer exists');
            }
            $access = $this->jwt->issueAccessToken($patient->getId(), 'customer');
        }

        return [
            'access_token' => $access,
            'token_type'   => 'Bearer',
            'expires_in'   => $this->jwt->accessTtl(),
        ];
    }
}
