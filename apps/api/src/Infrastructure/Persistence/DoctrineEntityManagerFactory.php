<?php

declare(strict_types=1);

namespace App\Infrastructure\Persistence;

use Doctrine\DBAL\DriverManager;
use Doctrine\DBAL\Types\Type;
use Doctrine\ORM\EntityManager;
use Doctrine\ORM\EntityManagerInterface;
use Doctrine\ORM\Mapping\UnderscoreNamingStrategy;
use Doctrine\ORM\ORMSetup;
use Symfony\Component\Cache\Adapter\ArrayAdapter;
use Symfony\Component\Cache\Adapter\FilesystemAdapter;

/**
 * One EntityManager per request, reused while open. `UnderscoreNamingStrategy`
 * gives `createdAt` -> `created_at` for free. Pinning `serverVersion` lets DBAL
 * resolve the platform without connecting, so DQL compiles offline in tests
 * (see ARCHITECTURE §12).
 */
final class DoctrineEntityManagerFactory
{
    private static ?EntityManagerInterface $instance = null;

    public static function create(): EntityManagerInterface
    {
        if (self::$instance !== null && self::$instance->isOpen()) {
            return self::$instance;
        }

        $isDev     = ($_ENV['APP_ENV'] ?? 'development') !== 'production';
        $cacheDir  = __DIR__ . '/../../../var/cache';
        $entityDir = __DIR__ . '/../../Domain/Entity';

        $config = ORMSetup::createAttributeMetadataConfiguration(
            paths:     [$entityDir],
            isDevMode: $isDev,
            proxyDir:  __DIR__ . '/../../../var/proxies',
            cache:     $isDev
                ? new ArrayAdapter()
                : new FilesystemAdapter(self::cacheNamespace($entityDir), 0, $cacheDir),
        );
        $config->setNamingStrategy(new UnderscoreNamingStrategy(CASE_LOWER));
        if (!$isDev) {
            $config->setAutoGenerateProxyClasses(false);
        }

        if (!Type::hasType('uuid')) {
            Type::addType('uuid', UuidType::class);
        }

        $params = [
            'driver'   => $_ENV['DB_DRIVER'] ?? 'pdo_pgsql',
            'host'     => $_ENV['DB_HOST'] ?? '127.0.0.1',
            'port'     => (int) ($_ENV['DB_PORT'] ?? 5432),
            'dbname'   => $_ENV['DB_NAME'] ?? 'videomed',
            'user'     => $_ENV['DB_USER'] ?? 'videomed',
            'password' => $_ENV['DB_PASSWORD'] ?? '',
            'charset'  => 'utf8',
        ];
        // Pinning the version means no connection is attempted for DQL compilation.
        if (!empty($_ENV['DB_SERVER_VERSION'])) {
            $params['serverVersion'] = (string) $_ENV['DB_SERVER_VERSION'];
        }

        $connection = DriverManager::getConnection($params, $config);

        return self::$instance = new EntityManager($connection, $config);
    }

    /**
     * The production metadata cache never expires, so it is namespaced by a
     * fingerprint of the entity files (names + modification times): a deploy
     * that changes any entity starts a fresh cache automatically, instead of
     * the app and the schema tool silently using the previous mappings.
     */
    private static function cacheNamespace(string $entityDir): string
    {
        $parts = [];
        foreach (glob($entityDir . '/*.php') ?: [] as $file) {
            $parts[] = basename($file) . ':' . (int) @filemtime($file);
        }
        sort($parts);

        return 'doctrine_' . substr(hash('sha256', implode('|', $parts)), 0, 12);
    }

    /** Reset the cached instance — for tests that build their own EM. */
    public static function reset(): void
    {
        self::$instance = null;
    }
}
