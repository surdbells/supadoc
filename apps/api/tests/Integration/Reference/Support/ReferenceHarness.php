<?php

declare(strict_types=1);

namespace App\Tests\Integration\Reference\Support;

use App\Infrastructure\Persistence\DoctrineEntityManagerFactory;
use DI\Container;
use DI\ContainerBuilder;
use Doctrine\ORM\EntityManagerInterface;
use Doctrine\ORM\Tools\SchemaTool;

/**
 * Postgres plumbing for the reference-data integration tests: the local
 * database from apps/api/.env, an isolated throw-away `reference_it_*` schema
 * per test class (`SET search_path`), and the app's real container bound to
 * it (a fresh one per "request").
 *
 * Safety: only a loopback DB_HOST is used unless INTEGRATION_DB=1 is set; the
 * tests only ever create and drop their own schema.
 */
final class ReferenceHarness
{
    public static function apiDir(): string
    {
        return dirname(__DIR__, 4);
    }

    public static function loadEnv(): void
    {
        \Dotenv\Dotenv::createImmutable(self::apiDir())->safeLoad();
        $_ENV['DB_SERVER_VERSION'] = $_ENV['DB_SERVER_VERSION'] ?? '16';
        $_ENV['ZEPTOMAIL_TOKEN']   = ''; // reviewer e-mails are logged as skipped, never sent
        $_ENV['REDIS_PREFIX']      = 'reference_it:';
    }

    /** Why the integration tests can't run here, or null when they can. */
    public static function unavailableReason(): ?string
    {
        self::loadEnv();
        if (($_ENV['DB_DRIVER'] ?? 'pdo_pgsql') !== 'pdo_pgsql' || !extension_loaded('pdo_pgsql')) {
            return 'integration tests need pdo_pgsql';
        }
        $host = (string) ($_ENV['DB_HOST'] ?? '127.0.0.1');
        if (!in_array($host, ['127.0.0.1', 'localhost', '::1'], true) && getenv('INTEGRATION_DB') !== '1') {
            return sprintf('DB_HOST %s is not local (set INTEGRATION_DB=1 to allow)', $host);
        }
        try {
            new \PDO(
                sprintf('pgsql:host=%s;port=%d;dbname=%s;connect_timeout=3', $host, (int) ($_ENV['DB_PORT'] ?? 5432), $_ENV['DB_NAME'] ?? 'videomed'),
                (string) ($_ENV['DB_USER'] ?? 'videomed'),
                (string) ($_ENV['DB_PASSWORD'] ?? ''),
                [\PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION],
            );
        } catch (\PDOException $e) {
            return 'Postgres unreachable: ' . $e->getMessage();
        }

        return null;
    }

    /** The app's container whose EntityManager (its own session) works inside `$schema`. */
    public static function container(string $schema): Container
    {
        self::loadEnv();
        DoctrineEntityManagerFactory::reset();
        $builder = new ContainerBuilder();
        $builder->addDefinitions(self::apiDir() . '/config/container.php');
        $container = $builder->build();
        $em        = $container->get(EntityManagerInterface::class);
        DoctrineEntityManagerFactory::reset(); // the next container gets a session of its own
        self::bind($em, $schema);

        return $container;
    }

    /** Create a fresh schema holding every mapped table; returns its name. */
    public static function createSchema(): string
    {
        $schema = 'reference_it_' . bin2hex(random_bytes(6));
        self::loadEnv();
        DoctrineEntityManagerFactory::reset();
        $admin = DoctrineEntityManagerFactory::create();
        DoctrineEntityManagerFactory::reset();
        $admin->getConnection()->executeStatement('CREATE SCHEMA ' . self::checkSchema($schema));
        $admin->getConnection()->close();

        $em = DoctrineEntityManagerFactory::create();
        DoctrineEntityManagerFactory::reset();
        self::bind($em, $schema);
        (new SchemaTool($em))->createSchema($em->getMetadataFactory()->getAllMetadata());
        $em->getConnection()->close();

        return $schema;
    }

    public static function dropSchema(string $schema): void
    {
        self::loadEnv();
        DoctrineEntityManagerFactory::reset();
        $admin = DoctrineEntityManagerFactory::create();
        DoctrineEntityManagerFactory::reset();
        $admin->getConnection()->executeStatement('DROP SCHEMA IF EXISTS ' . self::checkSchema($schema) . ' CASCADE');
        $admin->getConnection()->close();
    }

    private static function bind(EntityManagerInterface $em, string $schema): void
    {
        $conn = $em->getConnection();
        $conn->executeStatement(sprintf('SET search_path TO %s', $conn->quoteSingleIdentifier(self::checkSchema($schema))));
        $conn->executeStatement("SET application_name = 'reference_it'");
    }

    private static function checkSchema(string $schema): string
    {
        if (preg_match('/^reference_it_[0-9a-f]{12}$/', $schema) !== 1) {
            throw new \InvalidArgumentException('Not a reference integration-test schema: ' . $schema);
        }

        return $schema;
    }
}
