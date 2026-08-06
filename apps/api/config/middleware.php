<?php

declare(strict_types=1);

use App\Infrastructure\Middleware\CorsMiddleware;
use App\Infrastructure\Middleware\JsonBodyParserMiddleware;
use App\Infrastructure\Middleware\RateLimitMiddleware;
use App\Infrastructure\Middleware\ErrorHandler;
use Predis\Client as RedisClient;
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
    $app->add(new RateLimitMiddleware(
        $container->get(RedisClient::class),
        (int) ($_ENV['RATE_LIMIT_REQUESTS'] ?? 60),
        (int) ($_ENV['RATE_LIMIT_WINDOW'] ?? 60),
    ));

    $app->add(new JsonBodyParserMiddleware());

    $app->addRoutingMiddleware();

    $errorMiddleware = $app->addErrorMiddleware($debug, true, true, $logger);
    // Default handler re-applies CORS headers and reports only >= 500 to Sentry.
    $errorMiddleware->setDefaultErrorHandler(
        new ErrorHandler($app->getResponseFactory(), $logger, $debug),
    );

    // Added LAST → runs FIRST.
    $app->add(new CorsMiddleware(
        array_filter(array_map(
            'trim',
            explode(',', $_ENV['CORS_ALLOWED_ORIGINS'] ?? '*'),
        )),
    ));
};
