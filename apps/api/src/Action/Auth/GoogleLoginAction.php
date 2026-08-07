<?php

declare(strict_types=1);

namespace App\Action\Auth;

use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\AuthService;
use App\Infrastructure\Service\FirebaseIdTokenVerifier;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/portal/auth/google — customer sign-in with a Firebase ID token
 * (from the Google provider). The token is verified against Google's keys, then
 * the patient is signed in (or provisioned) and issued a customer-scoped JWT.
 */
final class GoogleLoginAction
{
    use ApiResponse;

    public function __construct(
        private readonly FirebaseIdTokenVerifier $verifier,
        private readonly AuthService $auth,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        $body    = (array) $request->getParsedBody();
        $idToken = trim((string) ($body['id_token'] ?? ''));

        if ($idToken === '') {
            return $this->error($response, 'Validation failed', 422, [
                'id_token' => 'A Google id_token is required',
            ]);
        }

        // Throws AuthenticationException (→ 401) on an invalid/unconfigured token.
        $identity = $this->verifier->verify($idToken);

        return $this->success(
            $response,
            $this->auth->loginCustomerWithGoogle($identity),
            'Signed in',
        );
    }
}
