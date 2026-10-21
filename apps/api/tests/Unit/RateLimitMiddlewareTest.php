<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Infrastructure\Middleware\RateLimitMiddleware;
use App\Infrastructure\Persistence\DoctrineEntityManagerFactory;
use DI\ContainerBuilder;
use PHPUnit\Framework\TestCase;
use Predis\Client as RedisClient;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\RequestHandlerInterface;
use Slim\App;
use Slim\Factory\AppFactory;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response;

/**
 * The rate limiter's buckets: per IP (kept apart by prefix) or per signed-in
 * user, the 429 contract (`errors {rate, code: rate_limited}` + Retry-After),
 * failing open without Redis, and — through the real global pipeline — which
 * bucket each kind of request lands in (token refresh has its own; a made-up
 * bearer never lifts the sign-in endpoints' limit).
 */
final class RateLimitMiddlewareTest extends TestCase
{
    private const ENV_KEYS = ['RATE_LIMIT_REQUESTS', 'RATE_LIMIT_WINDOW', 'RATE_LIMIT_AUTH_REQUESTS', 'RATE_LIMIT_BEARER_IP_REQUESTS', 'RATE_LIMIT_USER_REQUESTS', 'TRUSTED_PROXY_HOPS'];

    /** @var array<string,mixed> */
    private array $savedEnv = [];

    protected function setUp(): void
    {
        foreach (self::ENV_KEYS as $key) {
            $this->savedEnv[$key] = $_ENV[$key] ?? null;
            unset($_ENV[$key]);
        }
    }

    protected function tearDown(): void
    {
        foreach ($this->savedEnv as $key => $value) {
            if ($value === null) {
                unset($_ENV[$key]);
            } else {
                $_ENV[$key] = $value;
            }
        }
    }

    // ----- The middleware on its own -----

    public function testCountsPerIpAndRefusesWithTheContract(): void
    {
        $redis   = self::fakeRedis();
        $limiter = new RateLimitMiddleware($redis, 2, 60, 'ip');

        $this->assertSame(204, $limiter->process($this->request('203.0.113.7'), $this->ok())->getStatusCode());
        $second = $limiter->process($this->request('203.0.113.7'), $this->ok());
        $this->assertSame('2', $second->getHeaderLine('X-RateLimit-Limit'));
        $this->assertSame('0', $second->getHeaderLine('X-RateLimit-Remaining'));

        $refused = $limiter->process($this->request('203.0.113.7'), $this->ok());
        $this->assertSame(429, $refused->getStatusCode());
        $this->assertSame(
            ['status' => 'error', 'message' => 'Too many requests', 'errors' => ['rate' => 'Too many requests. Please wait a moment and try again.', 'code' => 'rate_limited']],
            json_decode((string) $refused->getBody(), true),
        );
        $retry = (int) $refused->getHeaderLine('Retry-After');
        $this->assertGreaterThanOrEqual(1, $retry);
        $this->assertLessThanOrEqual(60, $retry, 'only until this window resets');

        $this->assertSame(204, $limiter->process($this->request('198.51.100.1'), $this->ok())->getStatusCode(), 'another IP has its own bucket');
        $this->assertSame(60, $redis->ttls[array_key_first($redis->counts)]);
        $this->assertStringStartsWith('ratelimit:ip:203.0.113.7:', array_key_first($redis->counts));
    }

    public function testPrefixesKeepLimitersApart(): void
    {
        $redis = self::fakeRedis();
        $auth  = new RateLimitMiddleware($redis, 1, 60, 'auth');
        $ip    = new RateLimitMiddleware($redis, 1, 60, 'ip');

        $this->assertSame(204, $auth->process($this->request('203.0.113.7'), $this->ok())->getStatusCode());
        $this->assertSame(204, $ip->process($this->request('203.0.113.7'), $this->ok())->getStatusCode(), 'the refresh bucket does not use up the anonymous one');
        $this->assertSame(429, $auth->process($this->request('203.0.113.7'), $this->ok())->getStatusCode());
    }

    public function testPerUserBucketsFollowTheSignedInIdentity(): void
    {
        $redis   = self::fakeRedis();
        $limiter = new RateLimitMiddleware($redis, 1, 60, 'user', perUser: true);
        $staff   = $this->request('203.0.113.7')->withAttribute('user_id', 'u-1');
        $patient = $this->request('203.0.113.7')->withAttribute('customer_id', 'u-1');

        $this->assertSame(204, $limiter->process($staff, $this->ok())->getStatusCode());
        $this->assertSame(429, $limiter->process($staff, $this->ok())->getStatusCode());
        $this->assertSame(204, $limiter->process($patient, $this->ok())->getStatusCode(), 'same IP, same id string, other audience: its own bucket');
        $this->assertSame(204, $limiter->process($this->request('203.0.113.7')->withAttribute('user_id', 'u-2'), $this->ok())->getStatusCode(), 'a colleague behind the same NAT is not affected');

        $keys = array_keys($redis->counts);
        $this->assertStringStartsWith('ratelimit:user:s:u-1:', $keys[0]);
        $this->assertStringStartsWith('ratelimit:user:c:u-1:', $keys[1]);

        // Not signed in (no attribute): nothing to count, nothing refused.
        $before = $redis->calls;
        $this->assertSame(204, $limiter->process($this->request('203.0.113.7'), $this->ok())->getStatusCode());
        $this->assertSame($before, $redis->calls);
    }

    public function testFailsOpenWithoutRedisAndLaterLimitersDoNotRetry(): void
    {
        $redis       = self::fakeRedis();
        $redis->down = true;
        $outer       = new RateLimitMiddleware($redis, 1, 60, 'bearer');
        $inner       = new RateLimitMiddleware($redis, 1, 60, 'user', perUser: true);
        $handler     = new class ($inner) implements RequestHandlerInterface {
            public function __construct(private RateLimitMiddleware $inner)
            {
            }

            public function handle(ServerRequestInterface $request): ResponseInterface
            {
                return $this->inner->process($request->withAttribute('user_id', 'u-1'), new class implements RequestHandlerInterface {
                    public function handle(ServerRequestInterface $request): ResponseInterface
                    {
                        return new Response(204);
                    }
                });
            }
        };

        for ($i = 0; $i < 3; $i++) {
            $this->assertSame(204, $outer->process($this->request('203.0.113.7'), $handler)->getStatusCode());
        }
        $this->assertSame(3, $redis->calls, 'one attempt per request: the per-user limiter skipped Redis');
    }

    // ----- Which bucket the global pipeline picks (config/middleware.php) -----

    public function testRefreshAndSignOutHaveTheirOwnBucket(): void
    {
        $_ENV['RATE_LIMIT_REQUESTS']      = '1';
        $_ENV['RATE_LIMIT_AUTH_REQUESTS'] = '2';
        [$app, $redis] = $this->app();

        $this->assertSame(422, $this->send($app, 'POST', '/api/auth/login')->getStatusCode());
        $this->assertSame(429, $this->send($app, 'POST', '/api/auth/login')->getStatusCode(), 'the anonymous bucket is spent');

        $this->assertSame(422, $this->send($app, 'POST', '/api/auth/refresh')->getStatusCode(), 'a refresh still gets through');
        $this->assertSame(200, $this->send($app, 'POST', '/api/auth/logout')->getStatusCode(), 'and a sign-out');
        $limited = $this->send($app, 'POST', '/api/auth/refresh');
        $this->assertSame(429, $limited->getStatusCode());
        $this->assertSame('rate_limited', json_decode((string) $limited->getBody(), true)['errors']['code']);
        $this->assertNotSame('', $limited->getHeaderLine('Retry-After'));
        $this->assertStringContainsString('Retry-After', $limited->getHeaderLine('Access-Control-Expose-Headers'), 'readable by the browser');

        $this->assertSame(['auth', 'ip'], $this->prefixes($redis));
    }

    public function testAMadeUpBearerDoesNotLiftTheSignInLimit(): void
    {
        $_ENV['RATE_LIMIT_REQUESTS']           = '1';
        $_ENV['RATE_LIMIT_BEARER_IP_REQUESTS'] = '100';
        [$app, $redis] = $this->app();

        foreach (['/api/auth/login', '/api/portal/auth/login', '/api/portal/auth/phone/request-otp'] as $path) {
            $redis->counts = [];
            $this->send($app, 'POST', $path, 'Bearer made-up');
            $this->assertSame(429, $this->send($app, 'POST', $path, 'Bearer made-up')->getStatusCode(), "$path stays on the anonymous bucket");
            $this->assertSame(['ip'], $this->prefixes($redis));
        }

        $redis->counts = [];
        $this->send($app, 'GET', '/api/public/call/not-a-token/lobby', 'Bearer made-up');
        $this->assertSame(['ip'], $this->prefixes($redis), 'public endpoints too');
    }

    public function testBearerRequestsToAuthenticatedRoutesShareTheRoomierIpBucket(): void
    {
        $_ENV['RATE_LIMIT_REQUESTS']           = '1';
        $_ENV['RATE_LIMIT_BEARER_IP_REQUESTS'] = '3';
        [$app, $redis] = $this->app();

        for ($i = 0; $i < 3; $i++) {
            $res = $this->send($app, 'GET', '/api/me', 'Bearer not-a-jwt');
            $this->assertSame(401, $res->getStatusCode(), 'past the flood guard, refused by auth');
            $this->assertSame('token_invalid', json_decode((string) $res->getBody(), true)['errors']['code']);
        }
        $this->assertSame(429, $this->send($app, 'GET', '/api/portal/me', 'Bearer not-a-jwt')->getStatusCode(), 'one bucket per IP across both portals');
        $this->assertSame(['bearer'], $this->prefixes($redis), 'the per-user limit is never reached by an unauthenticated request');

        // No bearer: the anonymous bucket (and a 401 token_missing behind it).
        $redis->counts = [];
        $res           = $this->send($app, 'GET', '/api/me');
        $this->assertSame(401, $res->getStatusCode());
        $this->assertSame('token_missing', json_decode((string) $res->getBody(), true)['errors']['code']);
        $this->assertSame(['ip'], $this->prefixes($redis));
    }

    // ----- helpers -----

    private function request(string $ip, string $method = 'GET', string $path = '/api/me'): ServerRequestInterface
    {
        return (new ServerRequestFactory())->createServerRequest($method, $path, ['REMOTE_ADDR' => $ip]);
    }

    private function ok(): RequestHandlerInterface
    {
        return new class implements RequestHandlerInterface {
            public function handle(ServerRequestInterface $request): ResponseInterface
            {
                return new Response(204);
            }
        };
    }

    /** @return array{0: App, 1: RedisClient} the real app (global middleware + routes) over a fake Redis */
    private function app(): array
    {
        $_ENV['DB_SERVER_VERSION'] = '16';
        DoctrineEntityManagerFactory::reset();
        $redis   = self::fakeRedis();
        $builder = new ContainerBuilder();
        $builder->addDefinitions(__DIR__ . '/../../config/container.php');
        $builder->addDefinitions([RedisClient::class => $redis]);
        AppFactory::setContainer($builder->build());
        $app = AppFactory::create();
        (require __DIR__ . '/../../config/middleware.php')($app);
        (require __DIR__ . '/../../config/routes.php')($app);

        return [$app, $redis];
    }

    private function send(App $app, string $method, string $path, ?string $authorization = null): ResponseInterface
    {
        $request = $this->request('203.0.113.7', $method, $path)->withHeader('Content-Type', 'application/json');
        if ($authorization !== null) {
            $request = $request->withHeader('Authorization', $authorization);
        }
        $request->getBody()->write('{}');
        $request->getBody()->rewind();

        return $app->handle($request);
    }

    /** @return list<string> the bucket prefixes counted so far, sorted */
    private function prefixes(RedisClient $redis): array
    {
        $prefixes = array_values(array_unique(array_map(
            static fn (string $key): string => explode(':', $key)[1],
            array_keys($redis->counts),
        )));
        sort($prefixes);

        return $prefixes;
    }

    /** An in-memory stand-in for the two Redis commands the limiter uses. */
    private static function fakeRedis(): RedisClient
    {
        return new class extends RedisClient {
            /** @var array<string,int> */
            public array $counts = [];

            /** @var array<string,int> */
            public array $ttls = [];

            public bool $down = false;

            public int $calls = 0;

            public function __construct()
            {
            }

            public function incr(string $key): int
            {
                $this->calls++;
                if ($this->down) {
                    throw new \RuntimeException('Connection refused');
                }

                return $this->counts[$key] = ($this->counts[$key] ?? 0) + 1;
            }

            public function expire(string $key, int $seconds): int
            {
                $this->ttls[$key] = $seconds;

                return 1;
            }
        };
    }
}
