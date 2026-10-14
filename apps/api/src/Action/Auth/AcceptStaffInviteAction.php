<?php

declare(strict_types=1);

namespace App\Action\Auth;

use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\RequestClientTrait;
use App\Infrastructure\Service\StaffPasswordService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/auth/staff/accept-invite {token, password} — the invited doctor
 * chooses their password from the emailed link. The link is single-use; on
 * success the reply is the same session as a staff sign-in. A bad or expired
 * link (or a short password) is a 422 with the field error.
 */
final class AcceptStaffInviteAction
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
            $this->passwords->acceptInvite(
                (string) ($body['token'] ?? ''),
                (string) ($body['password'] ?? ''),
                $this->clientUserAgent($request),
                $this->clientIp($request),
            ),
            'Password set',
        );
    }
}
