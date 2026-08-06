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
 * Customer-portal authentication. The inverse of AuthMiddleware — accepts only
 * `customer`-scoped tokens and publishes `customer_id` for the portal Actions.
 */
final class CustomerAuthMiddleware implements MiddlewareInterface
{
    use ApiResponse;

    public function __construct(private readonly JwtService $jwt)
    {
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

        $request = $request->withAttribute('customer_id', $payload->sub);

        return $handler->handle($request);
    }
}
