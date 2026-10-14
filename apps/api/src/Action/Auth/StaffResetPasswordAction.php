<?php

declare(strict_types=1);

namespace App\Action\Auth;

use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\RequestClientTrait;
use App\Infrastructure\Service\StaffPasswordService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/auth/staff/reset-password {token, password} — choose a new password
 * from an emailed reset link (single-use, 1 hour) and sign in. A bad or expired
 * link (or a short password) is a 422 with the field error.
 */
final class StaffResetPasswordAction
{
    use ApiResponse;
    use RequestClientTrait;

    public function __construct(private readonly StaffPasswordService $passwords)
    {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        $body = (array) $request->getParsedBody();

        return $this->success(
            $response,
            $this->passwords->resetPassword(
                (string) ($body['token'] ?? ''),
                (string) ($body['password'] ?? ''),
                $this->clientUserAgent($request),
                $this->clientIp($request),
            ),
            'Password updated',
        );
    }
}
