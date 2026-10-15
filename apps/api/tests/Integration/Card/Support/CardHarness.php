<?php

declare(strict_types=1);

namespace App\Tests\Integration\Card\Support;

use App\Domain\Entity\Patient;
use App\Domain\Entity\Specialist;
use App\Domain\Enum\SpecialistStatus;
use App\Domain\Repository\PatientRepository;
use App\Infrastructure\Email\MailService;
use App\Infrastructure\Email\WalletMailer;
use App\Infrastructure\Persistence\DoctrineEntityManagerFactory;
use App\Infrastructure\Persistence\RawIndexes;
use App\Infrastructure\Service\CardPaymentGateway;
use DI\Container;
use DI\ContainerBuilder;
use Doctrine\ORM\EntityManagerInterface;
use Doctrine\ORM\Tools\SchemaTool;
use Monolog\Handler\TestHandler;
use Monolog\Logger;
use Monolog\LogRecord;

/**
 * Postgres plumbing for the card-payment integration tests and their worker
 * processes: the local database from apps/api/.env, one throw-away
 * `card_it_*` schema per test class (`SET search_path`, with the partial
 * unique indexes prod-migrate creates), and the app's REAL container
 * (config/container.php) bound to it — each container its own EntityManager
 * and database session, like a separate request. Only Paystack's verify is
 * faked ({@see FakeCardGateway}); nothing reaches a remote service (Paystack's
 * base URL points at a closed local port, mail is unconfigured).
 *
 * Safety: only a loopback DB_HOST is used unless INTEGRATION_DB=1 is set; the
 * tests only ever create and drop their own `card_it_*` schemas.
 */
final class CardHarness
{
    public const SECRET = 'sk_test_card_integration_only';

    public static function apiDir(): string
    {
        return dirname(__DIR__, 4);
    }

    public static function loadEnv(): void
    {
        \Dotenv\Dotenv::createImmutable(self::apiDir())->safeLoad();
        $_ENV['DB_SERVER_VERSION']                = $_ENV['DB_SERVER_VERSION'] ?? '16';
        $_ENV['PAYSTACK_SECRET_KEY']              = self::SECRET;
        $_ENV['PAYSTACK_PUBLIC_KEY']              = 'pk_test_card_integration_only';
        $_ENV['PAYSTACK_BASE_URL']                = 'http://127.0.0.1:9';
        $_ENV['ZEPTOMAIL_TOKEN']                  = '';
        $_ENV['REDIS_PREFIX']                     = 'card_it:';
        $_ENV['CARD_INTENT_CREDIT_AFTER_MINUTES'] = '30';
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
    public static function entityManager(string $schema, string $applicationName = 'card_it'): EntityManagerInterface
    {
        self::loadEnv();
        DoctrineEntityManagerFactory::reset();
        $em = DoctrineEntityManagerFactory::create();
        DoctrineEntityManagerFactory::reset(); // nobody else gets this instance
        self::bind($em, $schema, $applicationName);

        return $em;
    }

    /**
     * The app's container (its own EntityManager / session) inside `$schema`,
     * with Paystack's verify answered from `$gatewayFile`.
     */
    public static function container(string $schema, string $gatewayFile, string $applicationName = 'card_it'): Container
    {
        self::loadEnv();
        DoctrineEntityManagerFactory::reset();
        $builder = new ContainerBuilder();
        $builder->addDefinitions(self::apiDir() . '/config/container.php');
        $container = $builder->build();
        $container->set(CardPaymentGateway::class, new FakeCardGateway($gatewayFile));
        $em = $container->get(EntityManagerInterface::class);
        DoctrineEntityManagerFactory::reset(); // the next container gets a session of its own
        self::bind($em, $schema, $applicationName);

        return $container;
    }

    /**
     * Send `$container`'s wallet receipt e-mails to a log of their own (the
     * unconfigured mailer logs each one as skipped; count them with
     * {@see receipts()}). Call it before the container builds anything that
     * sends receipts. `$onSend` runs as each receipt is sent — to look at
     * what the database holds at that moment.
     */
    public static function recordReceipts(Container $container, ?callable $onSend = null): TestHandler
    {
        $log        = new TestHandler();
        $processors = $onSend === null ? [] : [static function (LogRecord $record) use ($onSend): LogRecord {
            $onSend();

            return $record;
        }];
        $container->set(WalletMailer::class, new WalletMailer(
            $container->get(PatientRepository::class),
            new MailService('', '', '', '', new Logger('receipts', [$log], $processors)),
        ));

        return $log;
    }

    /** Wallet receipts sent to a {@see recordReceipts()} log. */
    public static function receipts(TestHandler $log): int
    {
        return count(array_filter(
            $log->getRecords(),
            static fn (LogRecord $record): bool => str_contains($record->message, 'Email skipped'),
        ));
    }

    /** Create a fresh schema with every mapped table and the raw unique indexes; returns its name. */
    public static function createSchema(): string
    {
        $schema = 'card_it_' . bin2hex(random_bytes(6));
        self::loadEnv();
        DoctrineEntityManagerFactory::reset();
        $admin = DoctrineEntityManagerFactory::create();
        DoctrineEntityManagerFactory::reset();
        $admin->getConnection()->executeStatement('CREATE SCHEMA ' . $schema);
        $admin->getConnection()->close();

        $em = self::entityManager($schema);
        (new SchemaTool($em))->createSchema($em->getMetadataFactory()->getAllMetadata());
        foreach (RawIndexes::ensure($em->getConnection()) as $name => $outcome) {
            if ($outcome['status'] !== 'created') {
                throw new \RuntimeException("Could not create {$name}: " . json_encode($outcome));
            }
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
    }

    public static function seedPatient(EntityManagerInterface $em, string $tag = 'patient'): Patient
    {
        $patient = new Patient('card-it-' . $tag . '-' . bin2hex(random_bytes(4)) . '@example.com', 'Ada', 'Card');
        $em->persist($patient);
        $em->flush();

        return $patient;
    }

    /** An approved, bookable doctor (default weekday hours) charging `$fee`. */
    public static function seedSpecialist(EntityManagerInterface $em, string $fee = '10000.00'): Specialist
    {
        $specialist = new Specialist('Dr. Card Test ' . bin2hex(random_bytes(3)), 'General Practice');
        $specialist->setStatus(SpecialistStatus::APPROVED);
        $specialist->setAvailable(true);
        $specialist->setConsultationFee($fee);
        $em->persist($specialist);
        $em->flush();

        return $specialist;
    }

    /** Run a worker process (bin/card-worker.php) and return [process, pipes]. @param array<string,mixed> $job */
    public static function startWorker(array $job): array
    {
        $pipes   = [];
        $process = proc_open(
            [PHP_BINARY, __DIR__ . '/../bin/card-worker.php', base64_encode((string) json_encode($job))],
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

    /** Block until `$count` sessions named `$applicationName` are waiting on a lock (a row lock or an advisory lock). */
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
        if (preg_match('/^card_it_[0-9a-f]{12}$/', $schema) !== 1) {
            throw new \InvalidArgumentException('Not a card integration-test schema: ' . $schema);
        }

        return $schema;
    }
}
