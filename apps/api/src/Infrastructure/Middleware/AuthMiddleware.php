<?php

declare(strict_types=1);

namespace App\Infrastructure\Middleware;

use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\JwtService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\MiddlewareInterface;
use Psr\Http\Server\RequestHandlerInterface;
use Slim\Psr7\Response;

/**
 * Staff authentication. Validates the bearer token AND rejects tokens minted
 * for a different audience — without the scope check a valid customer token
 * would authenticate against staff routes (see ARCHITECTURE §8). Publishes
 * user_id / user_roles / user_permissions request attributes for RBAC.
 */
final class AuthMiddleware implements MiddlewareInterface
{
    use ApiResponse;

    public function __construct(private readonly JwtService $jwt)
    {
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

        $request = $request
            ->withAttribute('user_id', $payload->sub)
            ->withAttribute('user_roles', $payload->roles ?? [])
            ->withAttribute('user_permissions', $payload->permissions ?? []);

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
