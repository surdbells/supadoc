<?php

declare(strict_types=1);

namespace App\Tests\Integration\Wallet;

use App\Domain\Entity\WalletTransaction;
use App\Infrastructure\Service\WalletReconciler;
use App\Infrastructure\Service\WalletService;
use App\Tests\Integration\Wallet\Support\WalletHarness;
use Doctrine\ORM\EntityManagerInterface;
use Monolog\Handler\TestHandler;
use PHPUnit\Framework\TestCase;

/**
 * Base for the Postgres-backed wallet tests: one throw-away schema per test
 * class, skipped (not failed) when the local database is unreachable.
 */
abstract class WalletIntegrationTestCase extends TestCase
{
    protected static ?string $schema = null;

    private static ?string $skipReason = null;

    /** @var list<EntityManagerInterface> */
    private array $opened = [];

    private string|false $errorLog = false;

    public static function setUpBeforeClass(): void
    {
        self::$skipReason = WalletHarness::unavailableReason();
        static::$schema   = self::$skipReason === null ? WalletHarness::createSchema() : null;
    }

    public static function tearDownAfterClass(): void
    {
        if (static::$schema !== null) {
            WalletHarness::dropSchema(static::$schema);
            static::$schema = null;
        }
    }

    protected function setUp(): void
    {
        if (self::$skipReason !== null) {
            $this->markTestSkipped(self::$skipReason);
        }
        // The service's operational error_log lines (e.g. "HELD for review") are
        // expected here; keep them out of the test output.
        $this->errorLog = ini_set('error_log', sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'wallet-it-error.log');
    }

    protected function tearDown(): void
    {
        foreach ($this->opened as $em) {
            $em->getConnection()->close();
        }
        $this->opened = [];
        if ($this->errorLog !== false) {
            ini_set('error_log', $this->errorLog);
        }
    }

    /** A new EntityManager — its own DB session, like a separate request. */
    protected function em(string $applicationName = 'wallet_it'): EntityManagerInterface
    {
        $em             = WalletHarness::entityManager((string) static::$schema, $applicationName);
        $this->opened[] = $em;

        return $em;
    }

    /** @return array{0: WalletService, 1: TestHandler} */
    protected function walletService(EntityManagerInterface $em): array
    {
        $mail = new TestHandler();

        return [WalletHarness::walletService($em, $mail), $mail];
    }

    /** A patient with a pending ₦`$amount` top-up; returns [patientId, reference]. @return array{0:string,1:string} */
    protected function pendingTopup(string $amount = '5000.00', string $currency = 'NGN'): array
    {
        $em          = $this->em();
        $patientId   = WalletHarness::seedPatient($em);
        [$wallets]   = $this->walletService($em);
        $reference   = 'vmw_it_' . bin2hex(random_bytes(8));
        $wallets->beginTopup($patientId, $currency, $amount, $reference);

        return [$patientId, $reference];
    }

    /** What the database holds now (a fresh session, nothing cached). @return array<string,mixed> */
    protected function row(string $sql, array $params = []): array
    {
        $row = $this->em()->getConnection()->fetchAssociative($sql, $params);
        $this->assertIsArray($row, 'row exists: ' . $sql);

        return $row;
    }

    protected function balanceOf(string $patientId, string $currency = 'NGN'): string
    {
        return (string) $this->em()->getConnection()->fetchOne(
            'SELECT balance FROM wallets WHERE patient_id = ? AND currency = ?',
            [$patientId, $currency],
        );
    }

    /** Signed sum of the wallet's successful ledger entries. */
    protected function ledgerOf(string $patientId, string $currency = 'NGN'): string
    {
        return (string) $this->em()->getConnection()->fetchOne(
            "SELECT COALESCE(SUM(CASE WHEN t.direction = 'credit' THEN t.amount ELSE -t.amount END), 0)::numeric(18,2)
               FROM wallet_transactions t JOIN wallets w ON w.id = t.wallet_id
              WHERE w.patient_id = ? AND w.currency = ? AND t.status = 'success'",
            [$patientId, $currency],
        );
    }

    protected function statusOf(string $reference): string
    {
        return (string) $this->em()->getConnection()->fetchOne('SELECT status FROM wallet_transactions WHERE reference = ?', [$reference]);
    }

    protected function auditCount(string $action, string $reference): int
    {
        return (int) $this->em()->getConnection()->fetchOne(
            'SELECT COUNT(*) FROM audit_events WHERE action = ? AND resource_id = ?',
            [$action, $reference],
        );
    }

    protected function notificationCount(string $patientId, string $title): int
    {
        return (int) $this->em()->getConnection()->fetchOne(
            'SELECT COUNT(*) FROM notifications WHERE patient_id = ? AND title = ?',
            [$patientId, $title],
        );
    }

    /** The ledger entry under `$reference` loaded into `$em` (a request's in-memory copy). */
    protected function load(EntityManagerInterface $em, string $reference): WalletTransaction
    {
        $txn = $em->getRepository(WalletTransaction::class)->findOneBy(['reference' => $reference]);
        $this->assertInstanceOf(WalletTransaction::class, $txn);

        return $txn;
    }

    /** The read-only reconciliation report for this schema. @return array<string,mixed> */
    protected function reconcile(int $staleHours = 48): array
    {
        $conn   = $this->em()->getConnection();
        $report = (new WalletReconciler($conn))->run($staleHours);
        $this->assertFalse($conn->isTransactionActive(), 'its read-only transaction is closed');
        $this->assertTrue($report['read_only']);

        return $report;
    }

    /**
     * Run a bin/ command against this schema; returns its exit code and output.
     *
     * @param list<string>          $args
     * @param array<string, string> $env  extra environment (visible to PHP's $_ENV)
     * @return array{0:int, 1:string}
     */
    protected function runCommand(string $script, array $args = [], array $env = []): array
    {
        $pipes   = [];
        $process = proc_open(
            [PHP_BINARY, '-d', 'variables_order=EGPCS', $script, ...$args],
            [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']],
            $pipes,
            WalletHarness::apiDir(),
            $env + getenv() + ['PGOPTIONS' => '-c search_path=' . static::$schema],
        );
        $this->assertIsResource($process);
        fclose($pipes[0]);
        $out = (string) stream_get_contents($pipes[1]) . (string) stream_get_contents($pipes[2]);
        fclose($pipes[1]);
        fclose($pipes[2]);

        return [proc_close($process), $out];
    }

    /** A digest of every wallet and ledger row (and audit event) in this schema. */
    protected function fingerprint(): string
    {
        return (string) $this->em()->getConnection()->fetchOne(
            "SELECT md5(COALESCE((SELECT string_agg(w::text, '|' ORDER BY w.id) FROM wallets w), '')
                     || COALESCE((SELECT string_agg(t::text, '|' ORDER BY t.id) FROM wallet_transactions t), '')
                     || COALESCE((SELECT string_agg(a.id::text, '|' ORDER BY a.id) FROM audit_events a), ''))",
        );
    }

    /** @param array<string,mixed> $report @return list<array<string,mixed>> */
    protected function findingsOf(array $report, string $kind): array
    {
        return array_values(array_filter($report['findings'], static fn (array $f): bool => $f['kind'] === $kind));
    }

    /** Age a ledger row (and its posting) by `$interval` (e.g. '3 days'). */
    protected function age(string $reference, string $interval): void
    {
        $this->em()->getConnection()->executeStatement(
            "UPDATE wallet_transactions SET created_at = created_at - CAST(? AS interval),
                    posted_at = posted_at - CAST(? AS interval) WHERE reference = ?",
            [$interval, $interval, $reference],
        );
    }

    /** What the pre-fix late-failure race left: a credited top-up whose stale flush rewrote only `status`. */
    protected function leaveFailedAfterCredit(string $reference): void
    {
        $this->em()->getConnection()->executeStatement("UPDATE wallet_transactions SET status = 'failed' WHERE reference = ?", [$reference]);
    }
}
