<?php

declare(strict_types=1);

use App\Infrastructure\Persistence\DoctrineEntityManagerFactory;
use Doctrine\ORM\Tools\Console\ConsoleRunner;
use Doctrine\ORM\Tools\Console\EntityManagerProvider\SingleManagerProvider;

require __DIR__ . '/../vendor/autoload.php';

Dotenv\Dotenv::createImmutable(__DIR__ . '/..')->safeLoad();

// Doctrine ORM 3 CLI: `php bin/doctrine.php orm:schema-tool:update --dump-sql`
ConsoleRunner::run(
    new SingleManagerProvider(DoctrineEntityManagerFactory::create()),
);
