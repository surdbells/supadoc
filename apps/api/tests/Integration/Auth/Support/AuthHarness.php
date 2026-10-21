<?php

declare(strict_types=1);

namespace App\Tests\Integration\Auth\Support;

use App\Infrastructure\Persistence\DoctrineEntityManagerFactory;
use DI\Container;
use DI\ContainerBuilder;
use Doctrine\ORM\EntityManagerInterface;
use Doctrine\ORM\Tools\SchemaTool;
use Slim\App;
use Slim\Factory\AppFactory;

/**
 * Postgres (+ Redis) plumbing for the session / token integration tests: the
 * local database from apps/api/.env, an isolated throw-away `auth_it_*` schema
 * per test class (`SET search_path`), and the app's real container — or the
 * whole app, global middleware included — bound to it, a fresh one per
 * "request" so no Doctrine identity map outlives a request.
 *
 * The session limits are pinned (idle 3600 s, absolute 43200 s, access 900 s)
 * whatever the local .env says, and every environment value this harness sets
 * is put back afterwards ({@see restoreEnv()}).
 *
 * Safety: only a loopback DB_HOST is used unless INTEGRATION_DB=1 is set; the
 * tests only ever create and drop their own schema, and their Redis keys live
 * under their own prefix (and expire within a minute).
 */
final class AuthHarness
{
    public const IDLE     = 3600;
    public const ABSOLUTE = 43200;
    public const ACCESS   = 900;

    /** @var array<string, string|null> values replaced in $_ENV, to put back */
    private static array $saved = [];

    private static ?string $redisPrefix = null;

    public static function apiDir(): string
    {
        return dirname(__DIR__, 4);
    }

    public static function loadEnv(): void
    {
        \Dotenv\Dotenv::createImmutable(self::apiDir())->safeLoad();
        self::$redisPrefix ??= 'auth_it:' . bin2hex(random_bytes(4)) . ':';
        self::set([
            'DB_SERVER_VERSION'             => $_ENV['DB_SERVER_VERSION'] ?? '16',
            'ZEPTOMAIL_TOKEN'               => '', // sign-in e-mails are logged as skipped, never sent
            'REDIS_PREFIX'                  => self::$redisPrefix,
            'JWT_ACCESS_TTL'                => (string) self::ACCESS,
            'JWT_REFRESH_TTL'               => (string) self::ABSOLUTE,
            'SESSION_IDLE_TIMEOUT'          => (string) self::IDLE,
            'TRUSTED_PROXY_HOPS'            => '0',
        ]);
    }

    /** Limits no test reaches by accident (a test lowers one with {@see set()} until the next one starts). */
    public static function generousLimits(): void
    {
        self::set([
            'RATE_LIMIT_WINDOW'             => '60',
            'RATE_LIMIT_REQUESTS'           => '10000',
            'RATE_LIMIT_AUTH_REQUESTS'      => '10000',
            'RATE_LIMIT_BEARER_IP_REQUESTS' => '10000',
            'RATE_LIMIT_USER_REQUESTS'      => '10000',
        ]);
    }

    /** @param array<string,string> $values set in $_ENV (the first original of each key is kept for restoreEnv) */
    public static function set(array $values): void
    {
        foreach ($values as $key => $value) {
            if (!array_key_exists($key, self::$saved)) {
                self::$saved[$key] = isset($_ENV[$key]) ? (string) $_ENV[$key] : null;
            }
            $_ENV[$key] = $value;
        }
    }

    public static function restoreEnv(): void
    {
        foreach (self::$saved as $key => $value) {
            if ($value === null) {
                unset($_ENV[$key]);
            } else {
                $_ENV[$key] = $value;
            }
        }
        self::$saved = [];
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
        if (strlen((string) ($_ENV['JWT_SECRET'] ?? '')) < 32) {
            return 'JWT_SECRET in apps/api/.env must be at least 32 bytes';
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

    /** Why Redis-backed checks (rate limits) can't run, or null. */
    public static function redisUnavailableReason(): ?string
    {
        self::loadEnv();
        try {
            self::redis()->ping();
        } catch (\Throwable $e) {
            return 'Redis unreachable: ' . $e->getMessage();
        }

        return null;
    }

    /** Drop the rate-limit counters this run left behind (only keys under its own prefix). */
    public static function cleanRedis(): void
    {
        if (self::$redisPrefix === null) {
            return;
        }
        try {
            $redis = self::redis();
            $keys  = $redis->keys(self::$redisPrefix . '*');
            if ($keys !== []) {
                $redis->del($keys);
            }
        } catch (\Throwable) {
            // unreachable: nothing was written
        }
    }

    /** A client without the app's key prefix (keys() answers full names). */
    private static function redis(): \Predis\Client
    {
        return new \Predis\Client([
            'host'     => $_ENV['REDIS_HOST'] ?? '127.0.0.1',
            'port'     => (int) ($_ENV['REDIS_PORT'] ?? 6379),
            'password' => ($_ENV['REDIS_PASSWORD'] ?? '') !== '' ? $_ENV['REDIS_PASSWORD'] : null,
            'timeout'  => 2.0,
        ]);
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

    /** The whole app as public/index.php builds it (global middleware + routes), over `$schema`. */
    public static function app(string $schema): App
    {
        $container = self::container($schema);
        AppFactory::setContainer($container);
        $app = AppFactory::create();
        (require self::apiDir() . '/config/middleware.php')($app);
        (require self::apiDir() . '/config/routes.php')($app);

        return $app;
    }

    /** Create a fresh schema holding every mapped table; returns its name. */
    public static function createSchema(): string
    {
        $schema = 'auth_it_' . bin2hex(random_bytes(6));
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
        $conn->executeStatement("SET application_name = 'auth_it'");
    }

    private static function checkSchema(string $schema): string
    {
        if (preg_match('/^auth_it_[0-9a-f]{12}$/', $schema) !== 1) {
            throw new \InvalidArgumentException('Not an auth integration-test schema: ' . $schema);
        }

        return $schema;
    }
}
