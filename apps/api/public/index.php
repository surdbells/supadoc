<?php

declare(strict_types=1);

use App\Infrastructure\Persistence\SettingsRegistry;
use App\Infrastructure\Service\SettingsCacheService;
use DI\ContainerBuilder;
use Slim\Factory\AppFactory;

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
