<?php

declare(strict_types=1);

namespace App\Infrastructure\Middleware;

use App\Domain\Settings\WebUrls;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\MiddlewareInterface;
use Psr\Http\Server\RequestHandlerInterface;

/**
 * Records which web app the request came from (the browser's Origin header),
 * so sign-in can remember each user's site and links can follow it — see
 * {@see WebUrls}. Only configured sites are ever used; anything else is ignored.
 */
final class RequestOriginMiddleware implements MiddlewareInterface
{
    public function process(ServerRequestInterface $request, RequestHandlerInterface $handler): ResponseInterface
    {
        WebUrls::setRequestOrigin($request->getHeaderLine('Origin'));

        return $handler->handle($request);
    }
}
