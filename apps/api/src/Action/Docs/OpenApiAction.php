<?php

declare(strict_types=1);

namespace App\Action\Docs;

use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/** GET /api/docs/openapi.json — the raw OpenAPI document (not enveloped). */
final class OpenApiAction
{
    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        /** @var array<string, mixed> $spec */
        $spec = require __DIR__ . '/../../../config/openapi.php';

        $response->getBody()->write(
            (string) json_encode($spec, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE),
        );

        return $response->withHeader('Content-Type', 'application/json');
    }
}
