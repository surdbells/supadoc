<?php

declare(strict_types=1);

namespace App\Tests\Integration\Wallet\Support;

use App\Domain\Entity\Patient;
use App\Domain\Repository\NotificationRepository;
use App\Domain\Repository\PatientRepository;
use App\Domain\Repository\WalletRepository;
use App\Domain\Repository\WalletTransactionRepository;
use App\Infrastructure\Email\MailService;
use App\Infrastructure\Email\WalletMailer;
use App\Infrastructure\Persistence\DoctrineEntityManagerFactory;
use App\Infrastructure\Service\WalletService;
use Doctrine\ORM\EntityManagerInterface;
use Doctrine\ORM\Tools\SchemaTool;
use Monolog\Handler\TestHandler;
use Monolog\Logger;

/**
 * Postgres plumbing for the wallet integration tests (and their worker
 * processes): the local database from apps/api/.env, an isolated throw-away
 * schema per test class (`SET search_path`), and EntityManagers built exactly
 * like production's ({@see DoctrineEntityManagerFactory}) — each with its own
 * connection, i.e. its own database session.
 *
 * Safety: only a loopback DB_HOST is used unless INTEGRATION_DB=1 is set; the
 * tests only ever create and drop their own `wallet_it_*` schema.
 */
final class WalletHarness
{
    /** Subject of the receipt e-mail as logged by an unconfigured MailService. */
    private const MAIL_SKIPPED = 'Email skipped';

    public static function apiDir(): string
    {
        return dirname(__DIR__, 4);
    }

    public static function loadEnv(): void
    {
        \Dotenv\Dotenv::createImmutable(self::apiDir())->safeLoad();
        $_ENV['DB_SERVER_VERSION'] = $_ENV['DB_SERVER_VERSION'] ?? '16';
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

    /** A new EntityManager (own connection/session) working inside `$schema`. */
    public static function entityManager(string $schema, string $applicationName = 'wallet_it'): EntityManagerInterface
    {
        self::loadEnv();
        DoctrineEntityManagerFactory::reset();
        $em = DoctrineEntityManagerFactory::create();
        DoctrineEntityManagerFactory::reset(); // nobody else gets this instance
        $conn = $em->getConnection();
        $conn->executeStatement(sprintf('SET search_path TO %s', $conn->quoteSingleIdentifier(self::checkSchema($schema))));
        $conn->executeStatement('SET application_name = ' . $conn->quote($applicationName));

        return $em;
    }

    /** Create a fresh schema holding every mapped table; returns its name. */
    public static function createSchema(): string
    {
        $schema = 'wallet_it_' . bin2hex(random_bytes(6));
        self::loadEnv();
        DoctrineEntityManagerFactory::reset();
        $admin = DoctrineEntityManagerFactory::create();
        DoctrineEntityManagerFactory::reset();
        $admin->getConnection()->executeStatement('CREATE SCHEMA ' . $schema);
        $admin->getConnection()->close();

        $em = self::entityManager($schema);
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

    /** A WalletService wired like production, whose receipt e-mails land in `$mailLog`. */
    public static function walletService(EntityManagerInterface $em, TestHandler $mailLog): WalletService
    {
        $patients = new PatientRepository($em);
        $mailer   = new WalletMailer($patients, new MailService('', '', '', '', new Logger('mail', [$mailLog])));

        return new WalletService(
            $em,
            new WalletRepository($em),
            new WalletTransactionRepository($em),
            $mailer,
            new NotificationRepository($em),
            $patients,
            ['NGN', 'USD'],
        );
    }

    /** Receipt e-mails "sent" (logged as skipped by the unconfigured mailer). */
    public static function receipts(TestHandler $mailLog): int
    {
        return count(array_filter(
            $mailLog->getRecords(),
            static fn ($record): bool => str_contains($record->message, self::MAIL_SKIPPED),
        ));
    }

    /** A patient (with an e-mail, so receipts are attempted); returns their id. */
    public static function seedPatient(EntityManagerInterface $em): string
    {
        $patient = new Patient('wallet-it-' . bin2hex(random_bytes(4)) . '@example.com', 'Ada', 'Tester');
        $em->persist($patient);
        $em->flush();

        return $patient->getId();
    }

    /** Run a worker process (bin/wallet-worker.php) and return [process, pipes]. @param array<string,mixed> $job */
    public static function startWorker(array $job): array
    {
        $pipes   = [];
        $process = proc_open(
            [PHP_BINARY, __DIR__ . '/../bin/wallet-worker.php', base64_encode((string) json_encode($job))],
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
     * Wait for a worker to finish; returns its JSON result.
     *
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

    /**
     * Start the LOCAL fake of Paystack's verify endpoint (bin/fake-paystack.php
     * under `php -S` on a free loopback port — nothing reaches Paystack).
     *
     * @return array{process: resource, dir: string, port: int, url: string}
     */
    public static function startFakePaystack(): array
    {
        $dir = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'fake-paystack-' . bin2hex(random_bytes(4));
        mkdir($dir);
        $probe = stream_socket_server('tcp://127.0.0.1:0');
        $port  = (int) substr((string) strrchr((string) stream_socket_get_name($probe, false), ':'), 1);
        fclose($probe);

        $pipes   = [];
        $process = proc_open(
            [PHP_BINARY, '-S', '127.0.0.1:' . $port, __DIR__ . '/../bin/fake-paystack.php'],
            [0 => ['pipe', 'r'], 1 => ['file', $dir . '/server.log', 'a'], 2 => ['file', $dir . '/server.log', 'a']],
            $pipes,
            null,
            getenv() + ['FAKE_PAYSTACK_DIR' => $dir],
        );
        if (!is_resource($process)) {
            throw new \RuntimeException('Could not start the fake Paystack server');
        }
        $deadline = microtime(true) + 10;
        while (microtime(true) < $deadline) {
            $socket = @fsockopen('127.0.0.1', $port, $errno, $errstr, 0.2);
            if ($socket !== false) {
                fclose($socket);

                return ['process' => $process, 'dir' => $dir, 'port' => $port, 'url' => 'http://127.0.0.1:' . $port];
            }
            usleep(100_000);
        }

        throw new \RuntimeException('The fake Paystack server did not start');
    }

    /** @param array{process: resource, dir: string, port: int, url: string}|null $fake */
    public static function stopFakePaystack(?array $fake): void
    {
        if ($fake === null) {
            return;
        }
        if (is_resource($fake['process'])) {
            proc_terminate($fake['process']);
            proc_close($fake['process']);
        }
        array_map('unlink', glob($fake['dir'] . '/*') ?: []);
        @rmdir($fake['dir']);
    }

    /**
     * Script the fake's answer for `$reference` (Paystack's verify `data`).
     *
     * @param array<string,mixed> $extra more `data` fields (requested_amount, fees…)
     */
    public static function paystackSays(string $dir, string $reference, string $status, int $amountMinor, string $currency = 'NGN', array $extra = []): void
    {
        file_put_contents($dir . '/' . $reference . '.json', json_encode([
            'id'        => random_int(1_000_000, 9_999_999),
            'status'    => $status,
            'reference' => $reference,
            'amount'    => $amountMinor,
            'currency'  => $currency,
        ] + $extra));
    }

    /**
     * While the fake answers the NEXT verify of `$reference`, the top-up is
     * settled from another database session first — a webhook landing while
     * that request waits on Paystack. Runs once.
     */
    public static function settleDuringNextVerify(string $dir, string $schema, string $reference, string $amountMinor, string $currency = 'NGN'): void
    {
        file_put_contents($dir . '/' . $reference . '.during.json', json_encode([
            'schema'       => $schema,
            'amount_minor' => $amountMinor,
            'currency'     => $currency,
        ]));
    }

    /** How many times the fake was asked to verify `$reference`. */
    public static function gatewayCalls(string $dir, string $reference): int
    {
        $log = @file($dir . '/calls.log', FILE_IGNORE_NEW_LINES) ?: [];

        return count(array_filter($log, static fn (string $line): bool => $line === $reference));
    }

    /** Block until `$count` sessions named `$applicationName` are waiting on a row lock. */
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

    private static function checkSchema(string $schema): string
    {
        if (preg_match('/^wallet_it_[0-9a-f]{12}$/', $schema) !== 1) {
            throw new \InvalidArgumentException('Not a wallet integration-test schema: ' . $schema);
        }

        return $schema;
    }
}
