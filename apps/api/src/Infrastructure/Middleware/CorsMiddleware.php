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
        [$allow, $withCredentials] = $this->resolveOrigin($origin);

        $response = $response
            ->withHeader('Access-Control-Allow-Origin', $allow)
            ->withHeader('Vary', 'Origin')
            ->withHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept, X-Requested-With')
            ->withHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
            ->withHeader('Access-Control-Max-Age', '86400');

        // Credentials may only be combined with a specific, allow-listed origin —
        // never with a reflected/wildcard origin (that would defeat the same-origin
        // policy for authenticated requests).
        if ($withCredentials) {
            $response = $response->withHeader('Access-Control-Allow-Credentials', 'true');
        }

        return $response;
    }

    /**
     * @return array{0:string,1:bool} the Access-Control-Allow-Origin value and
     *   whether credentials may be allowed for it
     */
    private function resolveOrigin(string $origin): array
    {
        // Exact allow-list match → echo it and permit credentials.
        if ($origin !== '' && in_array($origin, $this->allowedOrigins, true)) {
            return [$origin, true];
        }

        // Wildcard (dev convenience only) → allow any origin but WITHOUT credentials.
        if (in_array('*', $this->allowedOrigins, true)) {
            return ['*', false];
        }

        // Fail closed: no allow-list match. Return a non-matching placeholder so the
        // browser blocks the cross-origin read, and never allow credentials.
        return [$this->allowedOrigins[0] ?? 'null', false];
    }
}
