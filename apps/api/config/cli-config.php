<?php

declare(strict_types=1);

use App\Infrastructure\Persistence\DoctrineEntityManagerFactory;
use Doctrine\ORM\Tools\Console\EntityManagerProvider\SingleManagerProvider;

require __DIR__ . '/../vendor/autoload.php';

Dotenv\Dotenv::createImmutable(__DIR__ . '/..')->safeLoad();

// Doctrine ORM 3 CLI bootstrap: expose a manager provider (used by bin/doctrine.php).
return new SingleManagerProvider(DoctrineEntityManagerFactory::create());
