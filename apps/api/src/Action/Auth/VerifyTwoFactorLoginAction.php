<?php

declare(strict_types=1);

namespace App\Action\Auth;

use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\AuthService;
use App\Infrastructure\Service\RequestClientTrait;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/portal/auth/2fa — second step of customer sign-in. Exchanges the
 * challenge from the password step, plus a TOTP or single-use recovery code, for
 * real tokens.
 */
final class VerifyTwoFactorLoginAction
{
    use ApiResponse;
    use RequestClientTrait;

    public function __construct(private readonly AuthService $auth)
    {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        $body      = (array) $request->getParsedBody();
        $challenge = trim((string) ($body['challenge'] ?? ''));
        $code      = trim((string) ($body['code'] ?? ''));

        $errors = [];
        if ($challenge === '') {
            $errors['challenge'] = 'Missing sign-in session';
        }
        if ($code === '') {
            $errors['code'] = 'Enter your authentication code';
        }
        if ($errors !== []) {
            return $this->error($response, 'Validation failed', 422, $errors);
        }

        return $this->success(
            $response,
            $this->auth->completeTwoFactorLogin(
                $challenge,
                $code,
                $this->clientUserAgent($request),
                $this->clientIp($request),
            ),
            'Signed in',
        );
    }
}
