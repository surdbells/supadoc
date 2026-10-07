<?php

declare(strict_types=1);

namespace App\Action\Auth;

use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\AuthService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/auth/logout — sign out the server session a refresh token belongs
 * to (patient or staff). Public on purpose: it must still work after the access
 * token expired (idle timeout, session expiry), and it always answers 200 so a
 * sign-out never fails or leaks whether the token was valid.
 */
final class LogoutAction
{
    use ApiResponse;

    public function __construct(private readonly AuthService $auth)
    {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        $body  = (array) $request->getParsedBody();
        $token = trim((string) ($body['refresh_token'] ?? ''));
        if ($token !== '') {
            $this->auth->logout($token);
        }

        return $this->success($response, null, 'Signed out');
    }
}
