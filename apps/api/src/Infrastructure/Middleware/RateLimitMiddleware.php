<?php

declare(strict_types=1);

namespace App\Infrastructure\Middleware;

use App\Infrastructure\Service\ApiResponse;
use Predis\Client as RedisClient;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\MiddlewareInterface;
use Psr\Http\Server\RequestHandlerInterface;
use Slim\Psr7\Response;

/**
 * Fixed-window rate limit keyed by client IP (or user id when authenticated).
 * Fails open if Redis is unreachable — availability over strictness.
 */
final class RateLimitMiddleware implements MiddlewareInterface
{
    use ApiResponse;

    public function __construct(
        private readonly RedisClient $redis,
        private readonly int $maxRequests = 60,
        private readonly int $windowSeconds = 60,
    ) {
    }

    public function process(
        ServerRequestInterface $request,
        RequestHandlerInterface $handler,
    ): ResponseInterface {
        $id     = (string) ($request->getAttribute('user_id') ?? $this->clientIp($request));
        $bucket = 'ratelimit:' . $id . ':' . floor(time() / $this->windowSeconds);

        try {
            $count = (int) $this->redis->incr($bucket);
            if ($count === 1) {
                $this->redis->expire($bucket, $this->windowSeconds);
            }
        } catch (\Throwable) {
            return $handler->handle($request); // fail open
        }

        if ($count > $this->maxRequests) {
            return $this->error(new Response(), 'Too many requests', 429)
                ->withHeader('Retry-After', (string) $this->windowSeconds);
        }

        $response  = $handler->handle($request);
        $remaining = max(0, $this->maxRequests - $count);

        return $response
            ->withHeader('X-RateLimit-Limit', (string) $this->maxRequests)
            ->withHeader('X-RateLimit-Remaining', (string) $remaining);
    }

    private function clientIp(ServerRequestInterface $request): string
    {
        $params = $request->getServerParams();
        $fwd    = $request->getHeaderLine('X-Forwarded-For');
        if ($fwd !== '') {
            return trim(explode(',', $fwd)[0]);
        }

        return (string) ($params['REMOTE_ADDR'] ?? 'unknown');
    }
}
