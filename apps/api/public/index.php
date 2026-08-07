<?php

declare(strict_types=1);

use App\Infrastructure\Persistence\SettingsRegistry;
use App\Infrastructure\Service\SettingsCacheService;
use DI\ContainerBuilder;
use Slim\Factory\AppFactory;

// Under `php -S ... public/index.php` the built-in server routes every request
// through this script. Let it serve existing static files in public/ (e.g.
// uploaded avatars) as-is — but never PHP and never outside the web root.
if (PHP_SAPI === 'cli-server') {
    $path = urldecode(parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/');
    if ($path !== '/' && !str_contains($path, '..') && !str_ends_with(strtolower($path), '.php')) {
        $file = realpath(__DIR__ . $path);
        if ($file !== false && is_file($file) && str_starts_with($file, __DIR__ . DIRECTORY_SEPARATOR)) {
            return false;
        }
    }
}

require __DIR__ . '/../vendor/autoload.php';

Dotenv\Dotenv::createImmutable(__DIR__ . '/..')->safeLoad();

// Sentry (no-op without SENTRY_DSN).
(require __DIR__ . '/../config/sentry.php')();

$builder = new ContainerBuilder();
// Container compilation is deliberately off — Doctrine does its own caching.
$builder->addDefinitions(__DIR__ . '/../config/container.php');
$container = $builder->build();

// Static handle for code that can't take DI (see the ARCHITECTURE registry note).
SettingsRegistry::set($container->get(SettingsCacheService::class));

AppFactory::setContainer($container);
$app = AppFactory::create();

(require __DIR__ . '/../config/middleware.php')($app);
(require __DIR__ . '/../config/routes.php')($app);

$app->run();
