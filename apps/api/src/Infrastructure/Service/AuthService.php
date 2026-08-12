<?php

declare(strict_types=1);

namespace App\Infrastructure\Service;

use App\Domain\Entity\Patient;
use App\Domain\Exception\AuthenticationException;
use App\Domain\Exception\ValidationException;
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
        private readonly SessionService $sessions,
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
    public function loginCustomer(
        string $email,
        string $password,
        string $userAgent = '',
        string $ip = '',
    ): array {
        $patient = $this->patients->findByEmail(strtolower(trim($email)));
        if ($patient === null || !$patient->verifyPassword($password)) {
            throw new AuthenticationException('Invalid email or password');
        }

        return $this->issueCustomerTokens($patient, $userAgent, $ip);
    }

    /**
     * Sign in (or provision) a patient from a verified Google identity — see
     * FirebaseIdTokenVerifier. The account is matched by email; a first-time
     * Google user gets a passwordless Patient row.
     *
     * @param array{sub:string, email:?string, name:?string, email_verified:bool} $identity
     * @return array{access_token:string, refresh_token:string, user:array}
     */
    public function loginCustomerWithGoogle(array $identity, string $userAgent = '', string $ip = ''): array
    {
        $email = strtolower(trim((string) ($identity['email'] ?? '')));
        if ($email === '') {
            throw new AuthenticationException('Google account has no email address');
        }

        $patient = $this->patients->findByEmail($email);
        if ($patient === null) {
            [$firstName, $lastName] = $this->splitName((string) ($identity['name'] ?? ''), $email);
            $patient = new Patient($email, $firstName, $lastName);
            $this->patients->save($patient);
        }

        return $this->issueCustomerTokens($patient, $userAgent, $ip);
    }

    /**
     * Register a patient after phone verification. Email is collected too (the
     * account is keyed by a unique email); the phone is the just-verified number.
     *
     * @return array{access_token:string, refresh_token:string, user:array}
     */
    public function registerCustomer(
        string $email,
        string $firstName,
        string $lastName,
        string $phone,
        string $password,
        string $userAgent = '',
        string $ip = '',
    ): array {
        $email = strtolower(trim($email));
        $phone = trim($phone);

        $errors = [];
        if ($email === '') {
            $errors['email'] = 'Email is required';
        } elseif ($this->patients->findByEmail($email) !== null) {
            $errors['email'] = 'An account with this email already exists';
        }
        if ($phone !== '' && $this->patients->findByPhone($phone) !== null) {
            $errors['phone'] = 'An account with this number already exists';
        }
        if ($errors !== []) {
            throw new ValidationException($errors);
        }

        $patient = new Patient($email, $firstName, $lastName);
        if ($phone !== '') {
            $patient->setPhone($phone);
            $patient->markPhoneVerified(); // the number was just proven over SMS
        }
        if ($password !== '') {
            $patient->setPassword($password);
        }
        $this->patients->save($patient);

        return $this->issueCustomerTokens($patient, $userAgent, $ip);
    }

    /** @return array{access_token:string, refresh_token:string, user:array} */
    public function loginCustomerByPhone(string $phone, string $userAgent = '', string $ip = ''): array
    {
        $patient = $this->patients->findByPhone(trim($phone));
        if ($patient === null) {
            throw new AuthenticationException('No account is registered with this number');
        }

        return $this->issueCustomerTokens($patient, $userAgent, $ip);
    }

    /**
     * Set a new password after email verification, and sign in.
     *
     * @return array{access_token:string, refresh_token:string, user:array}
     */
    public function resetPassword(string $email, string $newPassword, string $userAgent = '', string $ip = ''): array
    {
        $patient = $this->patients->findByEmail(strtolower(trim($email)));
        if ($patient === null) {
            throw new AuthenticationException('No account is registered with this email');
        }

        $patient->setPassword($newPassword);
        $this->patients->save($patient);

        return $this->issueCustomerTokens($patient, $userAgent, $ip);
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
            // Reuse the session the refresh token is bound to; if it was signed
            // out (revoked), the refresh must fail too.
            $jti = isset($payload->jti) ? (string) $payload->jti : null;
            if ($jti !== null && !$this->sessions->isActive($jti)) {
                throw new AuthenticationException('This session has been signed out');
            }
            $access = $this->jwt->issueAccessToken($patient->getId(), 'customer', jti: $jti);
        }

        return [
            'access_token' => $access,
            'token_type'   => 'Bearer',
            'expires_in'   => $this->jwt->accessTtl(),
        ];
    }

    /** @return array{access_token:string, refresh_token:string, user:array} */
    private function issueCustomerTokens(Patient $patient, string $userAgent = '', string $ip = ''): array
    {
        // Register a revocable session; its id becomes the token's jti.
        $jti = $this->sessions->start(
            $patient,
            $userAgent !== '' ? $userAgent : null,
            $ip !== '' ? $ip : null,
        );

        return [
            'access_token'  => $this->jwt->issueAccessToken($patient->getId(), 'customer', jti: $jti),
            'refresh_token' => $this->jwt->issueRefreshToken($patient->getId(), 'customer', $jti),
            'token_type'    => 'Bearer',
            'expires_in'    => $this->jwt->accessTtl(),
            'user'          => $patient->toArray(),
        ];
    }

    /**
     * Split a display name into first/last. Falls back to the email local-part
     * when Google didn't provide a name.
     *
     * @return array{0:string, 1:string}
     */
    private function splitName(string $name, string $email): array
    {
        $name = trim($name);
        if ($name === '') {
            $name = (string) strstr($email . '@', '@', true);
        }

        $parts = preg_split('/\s+/', $name) ?: [$name];
        $first = $parts[0] ?? $name;
        $last  = count($parts) > 1 ? implode(' ', array_slice($parts, 1)) : '';

        return [$first, $last];
    }
}
