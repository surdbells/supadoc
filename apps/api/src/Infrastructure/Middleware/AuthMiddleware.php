<?php

declare(strict_types=1);

namespace App\Infrastructure\Middleware;

use App\Domain\Enum\SessionState;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\JwtService;
use App\Infrastructure\Service\SessionService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\MiddlewareInterface;
use Psr\Http\Server\RequestHandlerInterface;
use Slim\Psr7\Response;

/**
 * Staff authentication. Validates the bearer token AND rejects tokens minted
 * for a different audience — without the scope check a valid customer token
 * would authenticate against staff routes (see ARCHITECTURE §8). Publishes
 * user_id / user_roles / user_permissions / session_id request attributes.
 */
final class AuthMiddleware implements MiddlewareInterface
{
    use ApiResponse;

    public function __construct(
        private readonly JwtService $jwt,
        private readonly ?SessionService $sessions = null,
    ) {
    }

    public function process(
        ServerRequestInterface $request,
        RequestHandlerInterface $handler,
    ): ResponseInterface {
        $token = $this->bearer($request);
        if ($token === null) {
            return $this->unauthorized('Missing bearer token');
        }

        try {
            $payload = $this->jwt->validateAccessToken($token);
        } catch (\Throwable) {
            return $this->unauthorized('Invalid or expired token');
        }

        if (($payload->scope ?? null) !== 'staff') {
            return $this->unauthorized('This token is not valid for staff endpoints');
        }

        // Session-bound tokens (every sign-in since staff sessions shipped) must
        // map to a live server session; activity is recorded (throttled) so the
        // idle clock tracks real use. A jti-less legacy access token lives out
        // its short TTL, after which its refresh is refused (see AuthService).
        $jti = (string) ($payload->jti ?? '');
        if ($jti !== '' && $this->sessions !== null) {
            $state = $this->sessions->staffState($jti, touch: true);
            if ($state !== SessionState::ACTIVE) {
                return $this->unauthorized($state->message());
            }
        }

        $request = $request
            ->withAttribute('user_id', $payload->sub)
            ->withAttribute('user_roles', $payload->roles ?? [])
            ->withAttribute('user_permissions', $payload->permissions ?? [])
            ->withAttribute('session_id', $jti);

        return $handler->handle($request);
    }

    private function bearer(ServerRequestInterface $request): ?string
    {
        $header = $request->getHeaderLine('Authorization');
        if (preg_match('/^Bearer\s+(.+)$/i', $header, $m) === 1) {
            return trim($m[1]);
        }

        return null;
    }

    private function unauthorized(string $message): ResponseInterface
    {
        return $this->error(new Response(), $message, 401);
    }
}
