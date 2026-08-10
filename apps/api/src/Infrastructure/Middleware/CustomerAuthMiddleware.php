<?php

declare(strict_types=1);

namespace App\Infrastructure\Middleware;

use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\JwtService;
use App\Infrastructure\Service\SessionService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\MiddlewareInterface;
use Psr\Http\Server\RequestHandlerInterface;
use Slim\Psr7\Response;

/**
 * Customer-portal authentication. The inverse of AuthMiddleware — accepts only
 * `customer`-scoped tokens and publishes `customer_id` for the portal Actions.
 */
final class CustomerAuthMiddleware implements MiddlewareInterface
{
    use ApiResponse;

    public function __construct(
        private readonly JwtService $jwt,
        private readonly SessionService $sessions,
    ) {
    }

    public function process(
        ServerRequestInterface $request,
        RequestHandlerInterface $handler,
    ): ResponseInterface {
        $header = $request->getHeaderLine('Authorization');
        if (preg_match('/^Bearer\s+(.+)$/i', $header, $m) !== 1) {
            return $this->error(new Response(), 'Missing bearer token', 401);
        }

        try {
            $payload = $this->jwt->validateAccessToken(trim($m[1]));
        } catch (\Throwable) {
            return $this->error(new Response(), 'Invalid or expired token', 401);
        }

        if (($payload->scope ?? null) !== 'customer') {
            return $this->error(
                new Response(),
                'This token is not valid for customer endpoints',
                401,
            );
        }

        // Tokens carry a jti tied to a revocable session; reject revoked ones.
        $jti = (string) ($payload->jti ?? '');
        if ($jti !== '' && !$this->sessions->isActive($jti)) {
            return $this->error(new Response(), 'This session has been signed out', 401);
        }

        $request = $request
            ->withAttribute('customer_id', $payload->sub)
            ->withAttribute('session_id', $jti);

        return $handler->handle($request);
    }
}
