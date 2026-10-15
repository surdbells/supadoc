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

    // Added 1st → runs LAST.
    $rateLimit = new RateLimitMiddleware(
        $container->get(RedisClient::class),
        (int) ($_ENV['RATE_LIMIT_REQUESTS'] ?? 60),
        (int) ($_ENV['RATE_LIMIT_WINDOW'] ?? 60),
    );
    // Paystack's webhook is exempt: every event comes from Paystack's few
    // addresses (a busy minute would be throttled into retries and delays),
    // and it is gated by its mandatory HMAC signature instead.
    $app->add(static function (ServerRequestInterface $request, RequestHandlerInterface $handler) use ($rateLimit): ResponseInterface {
        if (rtrim($request->getUri()->getPath(), '/') === '/api/webhooks/paystack') {
            return $handler->handle($request);
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
