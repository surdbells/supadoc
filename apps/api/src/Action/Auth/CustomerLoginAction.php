<?php

declare(strict_types=1);

namespace App\Action\Auth;

use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\AuthService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/portal/auth/login — customer (patient) sign-in. Issues a
 * `customer`-scoped token, which only the portal middleware accepts; it is
 * rejected by the staff middleware (see ARCHITECTURE §8).
 */
final class CustomerLoginAction
{
    use ApiResponse;

    public function __construct(private readonly AuthService $auth)
    {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        $body = (array) $request->getParsedBody();
        // The shared frontend client posts the identifier as `userName`; accept
        // either that or `email`.
        $email    = trim((string) ($body['email'] ?? $body['userName'] ?? ''));
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
            $this->auth->loginCustomer($email, $password),
            'Signed in',
        );
    }
}
