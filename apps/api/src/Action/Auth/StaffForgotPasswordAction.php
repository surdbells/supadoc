<?php

declare(strict_types=1);

namespace App\Action\Auth;

use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\StaffPasswordService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/auth/staff/forgot-password {email} — email a staff (doctor) login a
 * one-time reset link, valid for an hour. The reply is identical whether or not
 * the address has an account, so it can't be used to discover who does — in
 * content and in timing (the lookup and email happen after the reply). The link
 * is never part of the reply, in any environment. Rate limited by the global
 * limiter plus one email per address per minute.
 */
final class StaffForgotPasswordAction
{
    use ApiResponse;

    public function __construct(private readonly StaffPasswordService $passwords)
    {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        $body  = (array) $request->getParsedBody();
        $email = strtolower(trim((string) ($body['email'] ?? '')));

        if ($email === '' || !filter_var($email, FILTER_VALIDATE_EMAIL)) {
            return $this->error($response, 'Validation failed', 422, ['email' => 'Enter a valid email address']);
        }

        // Never echo the link back: anyone can call this, so it would hand over
        // any staff account. The work itself runs after this reply is sent.
        $this->passwords->requestReset($email);

        return $this->success(
            $response,
            ['sent' => true],
            'If an account exists for that email, we have sent a link to reset the password.',
        );
    }
}
