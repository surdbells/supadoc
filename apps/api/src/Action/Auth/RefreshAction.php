<?php

declare(strict_types=1);

namespace App\Action\Auth;

use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\AuthService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/** POST /api/auth/refresh — exchange a refresh token for a new access token. */
final class RefreshAction
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

        if ($token === '') {
            return $this->error($response, 'Validation failed', 422, [
                'refresh_token' => 'Refresh token is required',
            ]);
        }

        return $this->success($response, $this->auth->refresh($token), 'Token refreshed');
    }
}
