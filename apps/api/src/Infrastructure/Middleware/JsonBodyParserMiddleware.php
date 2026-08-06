<?php

declare(strict_types=1);

namespace App\Infrastructure\Middleware;

use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\MiddlewareInterface;
use Psr\Http\Server\RequestHandlerInterface;

/**
 * Parses a JSON request body into the parsed-body array so Actions read
 * `$request->getParsedBody()` uniformly. Invalid JSON is left as null for the
 * Action to reject.
 */
final class JsonBodyParserMiddleware implements MiddlewareInterface
{
    public function process(
        ServerRequestInterface $request,
        RequestHandlerInterface $handler,
    ): ResponseInterface {
        $contentType = $request->getHeaderLine('Content-Type');

        if (str_contains(strtolower($contentType), 'application/json')) {
            $contents = (string) $request->getBody();
            if ($contents !== '') {
                $decoded = json_decode($contents, true);
                if (json_last_error() === JSON_ERROR_NONE && is_array($decoded)) {
                    $request = $request->withParsedBody($decoded);
                }
            }
        }

        return $handler->handle($request);
    }
}
