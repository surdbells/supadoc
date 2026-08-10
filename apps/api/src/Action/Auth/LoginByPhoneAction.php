<?php

declare(strict_types=1);

namespace App\Action\Auth;

use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\AuthService;
use App\Infrastructure\Service\JwtService;
use App\Infrastructure\Service\RequestClientTrait;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/portal/auth/phone/login — sign in with a verified phone number.
 * Consumes the `verification_token` from verify-otp; the number is the auth
 * factor, so no password is needed.
 */
final class LoginByPhoneAction
{
    use ApiResponse;
    use RequestClientTrait;

    public function __construct(
        private readonly JwtService $jwt,
        private readonly AuthService $auth,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        $body  = (array) $request->getParsedBody();
        $token = trim((string) ($body['verification_token'] ?? ''));

        if ($token === '') {
            return $this->error($response, 'Validation failed', 422, [
                'verification_token' => 'Phone verification is required',
            ]);
        }

        $phone = $this->jwt->verifyPhoneProof($token);
        if ($phone === null) {
            return $this->error($response, 'Phone verification expired — please verify your number again', 401);
        }

        // loginCustomerByPhone throws AuthenticationException (→ 401) if no account.
        return $this->success(
            $response,
            $this->auth->loginCustomerByPhone(
                $phone,
                $this->clientUserAgent($request),
                $this->clientIp($request),
            ),
            'Signed in',
        );
    }
}
