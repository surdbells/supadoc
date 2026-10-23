<?php

declare(strict_types=1);

namespace App\Tests\Integration\DoctorApplications\Support;

use App\Infrastructure\Persistence\DoctrineEntityManagerFactory;
use App\Infrastructure\Persistence\RawIndexes;
use App\Infrastructure\Storage\FileVault;
use DI\Container;
use DI\ContainerBuilder;
use Doctrine\ORM\EntityManagerInterface;
use Doctrine\ORM\Tools\SchemaTool;
use Monolog\Handler\StreamHandler;
use Monolog\Level;
use Monolog\Logger;
use Psr\Http\Message\ResponseInterface;
use Psr\Log\LoggerInterface;
use Slim\Factory\AppFactory;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Factory\StreamFactory;
use Slim\Psr7\UploadedFile;

/**
 * Postgres plumbing for the doctor-application integration tests (modelled on
 * the document-sharing harness): the local database from apps/api/.env, an
 * isolated throw-away `docapp_it_*` schema per test class with the raw unique
 * indexes, the app's real container bound to it (a fresh one per request), a
 * private temporary vault, and real HTTP requests through the whole pipeline
 * (global middleware, routes, per-route limiters, the applicant token
 * middleware, staff auth). Worker processes (bin/*-worker.php) race real
 * requests.
 *
 * Safety: only a loopback DB_HOST is used unless INTEGRATION_DB=1 is set; the
 * tests only ever create and drop their own schema and vault directory.
 */
final class ApplicationsHarness
{
    /** When set, every container built logs here (PrivacyLogTest). */
    public static ?LoggerInterface $logger = null;

    private static ?LoggerInterface $sharedLogger = null;

    public static function apiDir(): string
    {
        return dirname(__DIR__, 4);
    }

    /** Redis key prefix of the current test (fresh counters per test); workers inherit it. */
    public static ?string $redisPrefix = null;

    public static function loadEnv(): void
    {
        \Dotenv\Dotenv::createImmutable(self::apiDir())->safeLoad();
        $_ENV['DB_SERVER_VERSION']  = $_ENV['DB_SERVER_VERSION'] ?? '16';
        $_ENV['APP_ENV']            = 'testing'; // dev_* codes and links come back
        $_ENV['ZEPTOMAIL_TOKEN']    = '';        // e-mails are logged as skipped, never sent
        $_ENV['TERMII_API_KEY']     = '';        // SMS unconfigured (notification_failed events)
        $_ENV['TRUSTED_PROXY_HOPS'] = '0';
        $_ENV['REDIS_PREFIX']       = self::$redisPrefix ?? (getenv('DOCAPP_IT_REDIS_PREFIX') ?: ('docapp_it:' . getmypid() . ':'));
        $_ENV['DOCAPP_IT_VAULT']    = getenv('DOCAPP_IT_VAULT') ?: (sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'docapp-it-vault-' . getmypid());
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

    /** The app's container whose EntityManager (its own session) works inside `$schema`, with the test vault. */
    public static function container(string $schema, string $applicationName = 'docapp_it'): Container
    {
        self::loadEnv();
        DoctrineEntityManagerFactory::reset();
        $builder = new ContainerBuilder();
        $builder->addDefinitions(self::apiDir() . '/config/container.php');
        $container = $builder->build();
        $container->set(FileVault::class, new FileVault(
            (string) $_ENV['DOCAPP_IT_VAULT'],
            FileVault::keyFrom('', (string) ($_ENV['JWT_SECRET'] ?? 'change-me'), false),
        ));
        // One logger for every container of the run: each new Monolog stream logger
        // keeps ~40KB alive, and these tests build a container per request.
        $container->set(LoggerInterface::class, self::$logger ?? (self::$sharedLogger ??= new Logger('docapp_it', [
            new StreamHandler(sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'docapp-it-app.log', Level::Debug),
        ])));
        $em = $container->get(EntityManagerInterface::class);
        DoctrineEntityManagerFactory::reset(); // the next container gets a session of its own
        self::bind($em, $schema, $applicationName);

        return $container;
    }

    /**
     * One real HTTP request through the whole app (a fresh container).
     *
     * @param array<string,mixed>|null $body JSON body (or multipart fields with `$file`)
     * @param array{path:string, name:string, mime:string}|null $file a multipart `file`
     * @return array{status:int, body:array<string,mixed>, response:ResponseInterface}
     */
    public static function http(string $schema, string $method, string $path, ?array $body = null, ?string $token = null, ?array $file = null, array $headers = [], string $app = 'docapp_it'): array
    {
        $container = self::container($schema, $app);
        AppFactory::setContainer($container);
        $slim = AppFactory::create();
        (require self::apiDir() . '/config/middleware.php')($slim);
        (require self::apiDir() . '/config/routes.php')($slim);

        $ip      = '10.' . random_int(0, 255) . '.' . random_int(0, 255) . '.' . random_int(1, 254);
        $request = (new ServerRequestFactory())->createServerRequest($method, $path, ['REMOTE_ADDR' => $ip])
            ->withHeader('User-Agent', 'docapp-it');
        foreach ($headers as $name => $value) {
            $request = $request->withHeader($name, $value);
        }
        if ($token !== null) {
            $request = $request->withHeader('Authorization', 'Bearer ' . $token);
        }
        if ($file !== null) {
            $request = $request
                ->withUploadedFiles(['file' => new UploadedFile($file['path'], $file['name'], $file['mime'], (int) filesize($file['path']), UPLOAD_ERR_OK)])
                ->withParsedBody($body ?? []);
        } elseif ($body !== null) {
            $request = $request
                ->withHeader('Content-Type', 'application/json')
                ->withBody((new StreamFactory())->createStream((string) json_encode($body)));
        }
        if ($path !== '' && str_contains($path, '?')) {
            parse_str((string) parse_url($path, PHP_URL_QUERY), $query);
            $request = $request->withQueryParams($query);
        }
        $response = $slim->handle($request);
        try {
            $container->get(EntityManagerInterface::class)->getConnection()->close();
        } catch (\Throwable) {
        }
        $decoded = json_decode((string) $response->getBody(), true);

        return ['status' => $response->getStatusCode(), 'body' => is_array($decoded) ? $decoded : [], 'response' => $response];
    }

    /** Create a fresh schema holding every mapped table and the raw indexes; returns its name. */
    public static function createSchema(): string
    {
        $schema = 'docapp_it_' . bin2hex(random_bytes(6));
        self::loadEnv();
        DoctrineEntityManagerFactory::reset();
        $admin = DoctrineEntityManagerFactory::create();
        DoctrineEntityManagerFactory::reset();
        $admin->getConnection()->executeStatement('CREATE SCHEMA ' . self::checkSchema($schema));
        $admin->getConnection()->close();

        $em = DoctrineEntityManagerFactory::create();
        DoctrineEntityManagerFactory::reset();
        self::bind($em, $schema, 'docapp_it');
        (new SchemaTool($em))->createSchema($em->getMetadataFactory()->getAllMetadata());
        $report = RawIndexes::ensure($em->getConnection());
        if (($report[RawIndexes::APPLICATION_OPEN_EMAIL]['status'] ?? '') !== 'created') {
            throw new \RuntimeException('open-email index not created: ' . json_encode($report));
        }
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
        self::removeVault();
    }

    public static function removeVault(): void
    {
        $dir = (string) ($_ENV['DOCAPP_IT_VAULT'] ?? '');
        if ($dir === '' || !str_contains($dir, 'docapp-it-vault-') || !is_dir($dir)) {
            return;
        }
        foreach (glob($dir . '/*/*.bin') ?: [] as $file) {
            @unlink($file);
        }
        foreach (glob($dir . '/*', GLOB_ONLYDIR) ?: [] as $sub) {
            @rmdir($sub);
        }
        @rmdir($dir);
    }

    /**
     * Start a worker process running one job (see bin/).
     *
     * @param array<string,mixed> $job
     * @return array{0: resource, 1: array<int, resource>}
     */
    public static function startWorker(string $script, array $job): array
    {
        $pipes   = [];
        $env     = getenv() + [
            'DOCAPP_IT_VAULT'        => (string) $_ENV['DOCAPP_IT_VAULT'],
            'DOCAPP_IT_REDIS_PREFIX' => (string) $_ENV['REDIS_PREFIX'],
        ];
        $process = proc_open(
            [PHP_BINARY, __DIR__ . '/../bin/' . $script, base64_encode((string) json_encode($job))],
            [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']],
            $pipes,
            self::apiDir(),
            $env,
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
        if (preg_match('/^docapp_it_[0-9a-f]{12}$/', $schema) !== 1) {
            throw new \InvalidArgumentException('Not a doctor-application integration-test schema: ' . $schema);
        }

        return $schema;
    }
}
