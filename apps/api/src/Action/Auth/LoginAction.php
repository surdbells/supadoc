<?php

declare(strict_types=1);

namespace App\Action\Auth;

use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\AuthService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/auth/login — staff sign-in. Invalid credentials throw
 * AuthenticationException, which the error handler maps to 401 (see §4).
 */
final class LoginAction
{
    use ApiResponse;

    public function __construct(private readonly AuthService $auth)
    {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        $body     = (array) $request->getParsedBody();
        $email    = trim((string) ($body['email'] ?? ''));
        $password = (string) ($body['password'] ?? '');

        $errors = [];
        if ($email === '') {
            $errors['email'] = 'Email is required';
        }
        if ($password === '') {
            $errors['password'] = 'Password is required';
        }
        if ($errors !== []) {
            return $this->error($response, 'Validation failed', 422, $errors);
        }

        return $this->success(
            $response,
            $this->auth->loginStaff($email, $password),
            'Signed in',
        );
    }
}
