<?php

declare(strict_types=1);

namespace App\Infrastructure\Middleware;

use App\Infrastructure\Http\TrustedClientIp;
use App\Infrastructure\Service\ApiResponse;
use Predis\Client as RedisClient;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\MiddlewareInterface;
use Psr\Http\Server\RequestHandlerInterface;
use Slim\Psr7\Response;

/**
 * Fixed-window rate limit. Two kinds of bucket:
 *
 *  - per client IP (the default), named by `$prefix`, so separate limiters
 *    (anonymous traffic, token refresh, bearer-authenticated traffic — see
 *    config/middleware.php) never share a counter;
 *  - per signed-in user (`$perUser`), keyed by the `user_id` / `customer_id`
 *    the auth middleware publishes, so it must run AFTER that middleware (in
 *    the route groups); without either attribute it does nothing.
 *
 * A refusal is 429 with `errors: {rate, code: rate_limited}` and a
 * `Retry-After` (seconds until the window resets). Fails open if Redis is
 * unreachable — availability over strictness — and tells later limiters in the
 * same request not to try again.
 */
final class RateLimitMiddleware implements MiddlewareInterface
{
    use ApiResponse;

    public const MESSAGE = 'Too many requests';

    public const DETAIL = 'Too many requests. Please wait a moment and try again.';

    /** Request attribute set once Redis failed in this request. */
    private const UNAVAILABLE = 'rate_limit_unavailable';

    public function __construct(
        private readonly RedisClient $redis,
        private readonly int $maxRequests = 60,
        private readonly int $windowSeconds = 60,
        private readonly string $prefix = 'ip',
        private readonly bool $perUser = false,
    ) {
    }

    public function process(
        ServerRequestInterface $request,
        RequestHandlerInterface $handler,
    ): ResponseInterface {
        if ($request->getAttribute(self::UNAVAILABLE) === true) {
            return $handler->handle($request);
        }
        $subject = $this->subject($request);
        if ($subject === null) {
            return $handler->handle($request);
        }

        $window = max(1, $this->windowSeconds);
        $now    = time();
        $slot   = intdiv($now, $window);
        $bucket = 'ratelimit:' . $this->prefix . ':' . $subject . ':' . $slot;

        try {
            $count = (int) $this->redis->incr($bucket);
            if ($count === 1) {
                $this->redis->expire($bucket, $window);
            }
        } catch (\Throwable) {
            return $handler->handle($request->withAttribute(self::UNAVAILABLE, true)); // fail open
        }

        if ($count > $this->maxRequests) {
            // Seconds until this fixed window ends (never 0: "retry now" would hammer).
            $retryAfter = max(1, ($slot + 1) * $window - $now);

            return $this->error(new Response(), self::MESSAGE, 429, ['rate' => self::DETAIL, 'code' => 'rate_limited'])
                ->withHeader('Retry-After', (string) $retryAfter)
                ->withHeader('X-RateLimit-Limit', (string) $this->maxRequests)
                ->withHeader('X-RateLimit-Remaining', '0');
        }

        $response  = $handler->handle($request);
        $remaining = max(0, $this->maxRequests - $count);

        return $response
            ->withHeader('X-RateLimit-Limit', (string) $this->maxRequests)
            ->withHeader('X-RateLimit-Remaining', (string) $remaining);
    }

    /** What this limiter counts by: the signed-in user, or the client IP; null = not limited. */
    private function subject(ServerRequestInterface $request): ?string
    {
        if (!$this->perUser) {
            return $this->clientIp($request);
        }
        $staff = (string) ($request->getAttribute('user_id') ?? '');
        if ($staff !== '') {
            return 's:' . $staff;
        }
        $customer = (string) ($request->getAttribute('customer_id') ?? '');

        return $customer !== '' ? 'c:' . $customer : null;
    }

    /** The client IP used to bucket anonymous requests (TRUSTED_PROXY_HOPS-aware, see TrustedClientIp). */
    private function clientIp(ServerRequestInterface $request): string
    {
        return TrustedClientIp::from($request);
    }
}
