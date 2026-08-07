<?php

declare(strict_types=1);

namespace App\Action\Auth;

use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\AuthService;
use App\Infrastructure\Service\JwtService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/portal/auth/reset-password — set a new password after email
 * verification (consumes the reset `verification_token`) and sign in.
 */
final class ResetPasswordAction
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
        $body        = (array) $request->getParsedBody();
        $token       = trim((string) ($body['verification_token'] ?? ''));
        $email       = strtolower(trim((string) ($body['email'] ?? '')));
        $newPassword = (string) ($body['new_password'] ?? '');

        $errors = [];
        if ($token === '') {
            $errors['verification_token'] = 'Email verification is required';
        }
        if (strlen($newPassword) < 8) {
            $errors['new_password'] = 'Password must be at least 8 characters';
        }
        if ($errors !== []) {
            return $this->error($response, 'Validation failed', 422, $errors);
        }

        $proofEmail = $this->jwt->verifyEmailProof($token);
        if ($proofEmail === null || strtolower($proofEmail) !== $email) {
            return $this->error($response, 'Email verification expired — please verify your email again', 401);
        }

        // resetPassword throws AuthenticationException (→ 401) if no account.
        return $this->success(
            $response,
            $this->auth->resetPassword($email, $newPassword),
            'Password updated',
        );
    }
}
