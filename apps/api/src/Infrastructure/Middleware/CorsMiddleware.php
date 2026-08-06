<?php

declare(strict_types=1);

namespace App\Infrastructure\Middleware;

use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\MiddlewareInterface;
use Psr\Http\Server\RequestHandlerInterface;
use Slim\Psr7\Response;

/**
 * Added LAST so it runs FIRST — its headers then survive onto error responses.
 * Short-circuits the CORS preflight OPTIONS.
 */
final class CorsMiddleware implements MiddlewareInterface
{
    /** @param list<string> $allowedOrigins */
    public function __construct(private readonly array $allowedOrigins = ['*'])
    {
    }

    public function process(
        ServerRequestInterface $request,
        RequestHandlerInterface $handler,
    ): ResponseInterface {
        if (strtoupper($request->getMethod()) === 'OPTIONS') {
            return $this->decorate($request, new Response(204));
        }

        return $this->decorate($request, $handler->handle($request));
    }

    public function decorate(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        $origin = $request->getHeaderLine('Origin');
        $allow  = $this->resolveOrigin($origin);

        return $response
            ->withHeader('Access-Control-Allow-Origin', $allow)
            ->withHeader('Vary', 'Origin')
            ->withHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept, X-Requested-With')
            ->withHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
            ->withHeader('Access-Control-Allow-Credentials', 'true')
            ->withHeader('Access-Control-Max-Age', '86400');
    }

    private function resolveOrigin(string $origin): string
    {
        if (in_array('*', $this->allowedOrigins, true)) {
            return $origin !== '' ? $origin : '*';
        }

        return in_array($origin, $this->allowedOrigins, true)
            ? $origin
            : ($this->allowedOrigins[0] ?? '*');
    }
}
