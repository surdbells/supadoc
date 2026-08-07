<?php

declare(strict_types=1);

namespace App\Action\Auth;

use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\AuthService;
use App\Infrastructure\Service\JwtService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/portal/auth/phone/register — create a patient after phone
 * verification. Consumes the `verification_token` from verify-otp for the phone,
 * and collects an email (accounts are keyed by a unique email) + name + password.
 */
final class RegisterByPhoneAction
{
    use ApiResponse;

    public function __construct(
        private readonly JwtService $jwt,
        private readonly AuthService $auth,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        $body      = (array) $request->getParsedBody();
        $token     = trim((string) ($body['verification_token'] ?? ''));
        $email     = trim((string) ($body['email'] ?? ''));
        $firstName = trim((string) ($body['first_name'] ?? ''));
        $lastName  = trim((string) ($body['last_name'] ?? ''));
        $password  = (string) ($body['password'] ?? '');

        $errors = [];
        if ($token === '') {
            $errors['verification_token'] = 'Phone verification is required';
        }
        if ($email === '') {
            $errors['email'] = 'Email is required';
        }
        if ($firstName === '') {
            $errors['first_name'] = 'First name is required';
        }
        if (strlen($password) < 8) {
            $errors['password'] = 'Password must be at least 8 characters';
        }
        if ($errors !== []) {
            return $this->error($response, 'Validation failed', 422, $errors);
        }

        $phone = $this->jwt->verifyPhoneProof($token);
        if ($phone === null) {
            return $this->error($response, 'Phone verification expired — please verify your number again', 401);
        }

        // registerCustomer throws ValidationException (→ 422) if email/phone taken.
        return $this->created(
            $response,
            $this->auth->registerCustomer($email, $firstName, $lastName, $phone, $password),
            'Account created',
        );
    }
}
