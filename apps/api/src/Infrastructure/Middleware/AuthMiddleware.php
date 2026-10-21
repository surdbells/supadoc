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
 * Staff authentication. Validates the bearer token AND rejects tokens minted
 * for a different audience — without the scope check a valid customer token
 * would authenticate against staff routes (see ARCHITECTURE §8). Publishes
 * user_id / user_roles / user_permissions / session_id request attributes.
 *
 * Every refusal is a 401 whose `errors.code` ({@see AuthErrorCode}) tells the
 * portal what to do: token_missing / token_expired / token_invalid → refresh
 * and retry; token_wrong_audience → a client bug; session_* → sign out now.
 * The messages are unchanged from before the codes existed.
 */
final class AuthMiddleware implements MiddlewareInterface
{
    use ApiResponse;

    /** `$sessions` null is a unit-test seam only: routes.php always passes the registry. */
    public function __construct(
        private readonly JwtService $jwt,
        private readonly ?SessionStateReader $sessions = null,
    ) {
    }

    public function process(
        ServerRequestInterface $request,
        RequestHandlerInterface $handler,
    ): ResponseInterface {
        $token = $this->bearer($request);
        if ($token === null) {
            return $this->deny('Missing bearer token', AuthErrorCode::TOKEN_MISSING);
        }

        try {
            $payload = $this->jwt->validateAccessToken($token);
        } catch (ExpiredException) {
            // Signature checked, only the 15-minute life is over: a refresh fixes it.
            return $this->deny('Invalid or expired token', AuthErrorCode::TOKEN_EXPIRED);
        } catch (\Throwable) {
            return $this->deny('Invalid or expired token', AuthErrorCode::TOKEN_INVALID);
        }

        if (($payload->scope ?? null) !== 'staff') {
            return $this->deny('This token is not valid for staff endpoints', AuthErrorCode::TOKEN_WRONG_AUDIENCE);
        }

        // Every access token is bound to a live server session by its jti (a
        // jti-less one is refused: none has been minted since sessions shipped,
        // and its refresh would be refused anyway). Activity is recorded
        // (throttled) so the idle clock tracks real use.
        $jti = (string) ($payload->jti ?? '');
        if ($this->sessions !== null) {
            $state = $this->sessions->staffState($jti, touch: true);
            if ($state !== SessionState::ACTIVE) {
                $reason = $state === SessionState::EXPIRED ? $this->sessions->staffExpiryReason($jti) : null;

                return $this->deny(
                    $state->message(),
                    $state->code() ?? AuthErrorCode::SESSION_INVALID,
                    $reason !== null ? ['reason' => $reason] : [],
                );
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

    /** @param array<string,string> $extra */
    private function deny(string $message, AuthErrorCode $code, array $extra = []): ResponseInterface
    {
        return $this->authError(new Response(), $message, $code, 401, $extra);
    }
}
