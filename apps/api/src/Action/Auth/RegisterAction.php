<?php

declare(strict_types=1);

namespace App\Action\Auth;

use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\AuthService;
use App\Infrastructure\Service\JwtService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/portal/auth/register — create a patient after email verification.
 * Consumes the email `verification_token` from verify-otp.
 */
final class RegisterAction
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
        $email     = strtolower(trim((string) ($body['email'] ?? '')));
        $firstName = trim((string) ($body['first_name'] ?? ''));
        $lastName  = trim((string) ($body['last_name'] ?? ''));
        $password  = (string) ($body['password'] ?? '');

        $errors = [];
        if ($token === '') {
            $errors['verification_token'] = 'Email verification is required';
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

        $proofEmail = $this->jwt->verifyEmailProof($token);
        if ($proofEmail === null || strtolower($proofEmail) !== $email) {
            return $this->error($response, 'Email verification expired — please verify your email again', 401);
        }

        // registerCustomer throws ValidationException (→ 422) if email is taken.
        return $this->created(
            $response,
            $this->auth->registerCustomer($email, $firstName, $lastName, '', $password),
            'Account created',
        );
    }
}
