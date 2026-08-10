<?php

declare(strict_types=1);

namespace App\Infrastructure\Service;

use Psr\Http\Message\ServerRequestInterface;

/** Pulls the calling device's user-agent and IP for session records. */
trait RequestClientTrait
{
    private function clientUserAgent(ServerRequestInterface $request): string
    {
        return substr($request->getHeaderLine('User-Agent'), 0, 500);
    }

    private function clientIp(ServerRequestInterface $request): string
    {
        $forwarded = $request->getHeaderLine('X-Forwarded-For');
        if ($forwarded !== '') {
            return trim(explode(',', $forwarded)[0]);
        }

        return (string) ($request->getServerParams()['REMOTE_ADDR'] ?? '');
    }
}
