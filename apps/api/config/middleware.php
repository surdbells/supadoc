<?php

declare(strict_types=1);

use App\Infrastructure\Middleware\CorsMiddleware;
use App\Infrastructure\Middleware\JsonBodyParserMiddleware;
use App\Infrastructure\Middleware\RateLimitMiddleware;
use App\Infrastructure\Middleware\RequestOriginMiddleware;
use App\Infrastructure\Middleware\ErrorHandler;
use Predis\Client as RedisClient;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\RequestHandlerInterface;
use Psr\Log\LoggerInterface;
use Slim\App;

/**
 * Global pipeline. Slim dispatches middleware LIFO — last-added runs FIRST
 * (see ARCHITECTURE §4). CORS is added last so it runs first and its headers
 * survive onto error responses. Error middleware is added AFTER routing so it
 * also catches routing (404/405) errors.
 */
return static function (App $app): void {
    $container = $app->getContainer();
    $debug     = ($_ENV['APP_DEBUG'] ?? 'false') === 'true';
    $logger    = $container->get(LoggerInterface::class);

    // Added 1st → runs LAST. Per-IP buckets, kept apart by prefix (the
    // per-user limit lives on the authenticated route groups, after auth —
    // see config/routes.php):
    //  - anonymous traffic, incl. every sign-in / OTP endpoint (brute force);
    //  - token refresh + sign-out, so a busy clinic NAT can always refresh;
    //  - bearer requests to authenticated routes: a coarse flood guard for a
    //    clinic behind one address (users are limited one by one after auth).
    $redis  = $container->get(RedisClient::class);
    $window = (int) ($_ENV['RATE_LIMIT_WINDOW'] ?? 60);
    $rateLimit = new RateLimitMiddleware($redis, (int) ($_ENV['RATE_LIMIT_REQUESTS'] ?? 60), $window, 'ip');
    $authLimit = new RateLimitMiddleware($redis, (int) ($_ENV['RATE_LIMIT_AUTH_REQUESTS'] ?? 60), $window, 'auth');
    $bearerIpLimit = new RateLimitMiddleware($redis, (int) ($_ENV['RATE_LIMIT_BEARER_IP_REQUESTS'] ?? 1200), $window, 'bearer');
    // Paystack's webhook is exempt: every event comes from Paystack's few
    // addresses (a busy minute would be throttled into retries and delays),
    // and it is gated by its mandatory HMAC signature instead.
    // NOT `static`: Slim binds closure middleware to the container, and binding
    // a static closure fails — every request would then be a fatal error.
    $app->add(function (ServerRequestInterface $request, RequestHandlerInterface $handler) use ($rateLimit, $authLimit, $bearerIpLimit): ResponseInterface {
        $path = rtrim($request->getUri()->getPath(), '/');
        if ($path === '/api/webhooks/paystack') {
            return $handler->handle($request);
        }
        if ($path === '/api/auth/refresh' || $path === '/api/auth/logout') {
            return $authLimit->process($request, $handler);
        }
        // Only authenticated routes get the roomier bearer bucket: the public,
        // sign-in and OTP endpoints stay on the anonymous one whatever headers
        // arrive (a made-up bearer must not lift the brute-force limit).
        $anonymousRoute = !str_starts_with($path, '/api/')
            || preg_match('#^/api/(auth|portal/auth|public|webhooks|docs)(/|$)#', $path) === 1;
        if (!$anonymousRoute && preg_match('/^Bearer\s+\S/i', $request->getHeaderLine('Authorization')) === 1) {
            return $bearerIpLimit->process($request, $handler);
        }

        return $rateLimit->process($request, $handler);
    });

    $app->add(new JsonBodyParserMiddleware());

    // Which web app (patient / doctor site) the request came from — see WebUrls.
    $app->add(new RequestOriginMiddleware());

    $app->addRoutingMiddleware();

    $errorMiddleware = $app->addErrorMiddleware($debug, true, true, $logger);
    // Default handler re-applies CORS headers and reports only >= 500 to Sentry.
    $errorMiddleware->setDefaultErrorHandler(
        new ErrorHandler($app->getResponseFactory(), $logger, $debug),
    );

    // Added LAST → runs FIRST. Fail closed: with CORS_ALLOWED_ORIGINS unset, no
    // cross-origin access is granted (secure by default). Set it explicitly per env.
    $app->add(new CorsMiddleware(
        array_values(array_filter(array_map(
            'trim',
            explode(',', $_ENV['CORS_ALLOWED_ORIGINS'] ?? ''),
        ))),
    ));
};
