<?php

declare(strict_types=1);

namespace App\Tests\Integration\DocumentSharing\Support;

use App\Infrastructure\Persistence\DoctrineEntityManagerFactory;
use App\Infrastructure\Persistence\RawIndexes;
use DI\Container;
use DI\ContainerBuilder;
use Doctrine\ORM\EntityManagerInterface;
use Doctrine\ORM\Tools\SchemaTool;

/**
 * Postgres plumbing for the document-sharing integration tests (copied from
 * the reference-data harness): the local database from apps/api/.env, an
 * isolated throw-away `docshare_it_*` schema per test class (`SET
 * search_path`) with the partial unique indexes RawIndexes owns, and the
 * app's real container bound to it (a fresh one per "request"). Worker
 * processes (bin/docshare-worker.php) run real concurrent requests.
 *
 * Safety: only a loopback DB_HOST is used unless INTEGRATION_DB=1 is set; the
 * tests only ever create and drop their own schema.
 */
final class DocShareHarness
{
    public static function apiDir(): string
    {
        return dirname(__DIR__, 4);
    }

    public static function loadEnv(): void
    {
        \Dotenv\Dotenv::createImmutable(self::apiDir())->safeLoad();
        $_ENV['DB_SERVER_VERSION'] = $_ENV['DB_SERVER_VERSION'] ?? '16';
        $_ENV['ZEPTOMAIL_TOKEN']   = ''; // e-mails are logged as skipped, never sent
        $_ENV['REDIS_PREFIX']      = 'docshare_it:' . getmypid() . ':';
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
    public static function container(string $schema, string $applicationName = 'docshare_it'): Container
    {
        self::loadEnv();
        DoctrineEntityManagerFactory::reset();
        $builder = new ContainerBuilder();
        $builder->addDefinitions(self::apiDir() . '/config/container.php');
        $container = $builder->build();
        $em        = $container->get(EntityManagerInterface::class);
        DoctrineEntityManagerFactory::reset(); // the next container gets a session of its own
        self::bind($em, $schema, $applicationName);

        return $container;
    }

    /** Create a fresh schema holding every mapped table and the raw indexes; returns its name. */
    public static function createSchema(): string
    {
        $schema = 'docshare_it_' . bin2hex(random_bytes(6));
        self::loadEnv();
        DoctrineEntityManagerFactory::reset();
        $admin = DoctrineEntityManagerFactory::create();
        DoctrineEntityManagerFactory::reset();
        $admin->getConnection()->executeStatement('CREATE SCHEMA ' . self::checkSchema($schema));
        $admin->getConnection()->close();

        $em = DoctrineEntityManagerFactory::create();
        DoctrineEntityManagerFactory::reset();
        self::bind($em, $schema, 'docshare_it');
        (new SchemaTool($em))->createSchema($em->getMetadataFactory()->getAllMetadata());
        RawIndexes::ensure($em->getConnection());
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

    /**
     * Start a worker process (bin/docshare-worker.php) running one job.
     *
     * @param array<string,mixed> $job
     * @return array{0: resource, 1: array<int, resource>}
     */
    public static function startWorker(array $job): array
    {
        $pipes   = [];
        $process = proc_open(
            [PHP_BINARY, __DIR__ . '/../bin/docshare-worker.php', base64_encode((string) json_encode($job))],
            [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']],
            $pipes,
            self::apiDir(),
        );
        if (!is_resource($process)) {
            throw new \RuntimeException('Could not start a worker process');
        }
        fclose($pipes[0]);

        return [$process, $pipes];
    }

    /**
     * @param array{0: resource, 1: array<int, resource>} $worker
     * @return array<string,mixed>
     */
    public static function finishWorker(array $worker): array
    {
        [$process, $pipes] = $worker;
        $out = (string) stream_get_contents($pipes[1]);
        $err = (string) stream_get_contents($pipes[2]);
        fclose($pipes[1]);
        fclose($pipes[2]);
        $code = proc_close($process);

        $lines  = array_values(array_filter(array_map('trim', explode("\n", $out)), static fn (string $l): bool => str_starts_with($l, '{')));
        $result = $lines !== [] ? json_decode((string) end($lines), true) : null;
        if (!is_array($result)) {
            throw new \RuntimeException(sprintf("Worker failed (exit %d)\nstdout: %s\nstderr: %s", $code, $out, $err));
        }

        return $result;
    }

    /** Block until `$count` sessions named `$applicationName` wait on a lock. */
    public static function awaitLockWaiters(EntityManagerInterface $observer, string $applicationName, int $count, float $timeoutSeconds = 30.0): void
    {
        $deadline = microtime(true) + $timeoutSeconds;
        do {
            $waiting = (int) $observer->getConnection()->fetchOne(
                "SELECT COUNT(*) FROM pg_stat_activity WHERE application_name = ? AND wait_event_type = 'Lock'",
                [$applicationName],
            );
            if ($waiting >= $count) {
                return;
            }
            usleep(50_000);
        } while (microtime(true) < $deadline);

        throw new \RuntimeException(sprintf('Only %d of %d workers reached the lock within %.0fs', $waiting, $count, $timeoutSeconds));
    }

    private static function bind(EntityManagerInterface $em, string $schema, string $applicationName): void
    {
        $conn = $em->getConnection();
        $conn->executeStatement(sprintf('SET search_path TO %s', $conn->quoteSingleIdentifier(self::checkSchema($schema))));
        $conn->executeStatement('SET application_name = ' . $conn->quote($applicationName));
    }

    private static function checkSchema(string $schema): string
    {
        if (preg_match('/^docshare_it_[0-9a-f]{12}$/', $schema) !== 1) {
            throw new \InvalidArgumentException('Not a document-sharing integration-test schema: ' . $schema);
        }

        return $schema;
    }
}
