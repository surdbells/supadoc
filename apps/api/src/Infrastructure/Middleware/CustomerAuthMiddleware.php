<?php

declare(strict_types=1);

namespace App\Infrastructure\Middleware;

use App\Domain\Enum\AuthErrorCode;
use App\Domain\Enum\SessionState;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\JwtService;
use App\Infrastructure\Service\SessionStateReader;
use Firebase\JWT\ExpiredException;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\MiddlewareInterface;
use Psr\Http\Server\RequestHandlerInterface;
use Slim\Psr7\Response;

/**
 * Customer-portal authentication. The inverse of AuthMiddleware — accepts only
 * `customer`-scoped tokens and publishes `customer_id` for the portal Actions.
 * Refusals carry the same `errors.code` contract ({@see AuthErrorCode}).
 */
final class CustomerAuthMiddleware implements MiddlewareInterface
{
    use ApiResponse;

    public function __construct(
        private readonly JwtService $jwt,
        private readonly SessionStateReader $sessions,
    ) {
    }

    public function process(
        ServerRequestInterface $request,
        RequestHandlerInterface $handler,
    ): ResponseInterface {
        $header = $request->getHeaderLine('Authorization');
        if (preg_match('/^Bearer\s+(.+)$/i', $header, $m) !== 1) {
            return $this->deny('Missing bearer token', AuthErrorCode::TOKEN_MISSING);
        }

        try {
            $payload = $this->jwt->validateAccessToken(trim($m[1]));
        } catch (ExpiredException) {
            return $this->deny('Invalid or expired token', AuthErrorCode::TOKEN_EXPIRED);
        } catch (\Throwable) {
            return $this->deny('Invalid or expired token', AuthErrorCode::TOKEN_INVALID);
        }

        if (($payload->scope ?? null) !== 'customer') {
            return $this->deny('This token is not valid for customer endpoints', AuthErrorCode::TOKEN_WRONG_AUDIENCE);
        }

        // Tokens carry a jti tied to a revocable, time-boxed session: reject
        // signed-out / idle / expired ones (and a jti-less one: there is no
        // session to check, so it fails closed), and record activity on live
        // ones (throttled) so the server-side idle clock tracks real use. A
        // background poll (`X-SD-Passive: 1`) is checked the same way but is
        // not activity: it never keeps an idle session alive.
        $jti   = (string) ($payload->jti ?? '');
        $state = $this->sessions->customerState($jti, touch: !AuthMiddleware::isPassive($request));
        if ($state !== SessionState::ACTIVE) {
            $reason = $state === SessionState::EXPIRED ? $this->sessions->customerExpiryReason($jti) : null;

            return $this->deny(
                $state->message(),
                $state->code() ?? AuthErrorCode::SESSION_INVALID,
                $reason !== null ? ['reason' => $reason] : [],
            );
        }

        $request = $request
            ->withAttribute('customer_id', $payload->sub)
            ->withAttribute('session_id', $jti);

        return $handler->handle($request);
    }

    /** @param array<string,string> $extra */
    private function deny(string $message, AuthErrorCode $code, array $extra = []): ResponseInterface
    {
        return $this->authError(new Response(), $message, $code, 401, $extra);
    }
}
