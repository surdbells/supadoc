<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Domain\Entity\AuditEvent;
use App\Domain\Entity\Wallet;
use App\Domain\Entity\WalletTransaction;
use App\Domain\Repository\NotificationRepository;
use App\Domain\Repository\PatientRepository;
use App\Domain\Repository\WalletRepository;
use App\Domain\Repository\WalletTransactionRepository;
use App\Infrastructure\Email\MailService;
use App\Infrastructure\Email\WalletMailer;
use App\Infrastructure\Service\WalletService;
use Doctrine\DBAL\Connection;
use Doctrine\DBAL\LockMode;
use Doctrine\ORM\EntityManagerInterface;
use Doctrine\ORM\Mapping\ClassMetadata;
use Doctrine\ORM\Persisters\Entity\EntityPersister;
use Doctrine\ORM\UnitOfWork;
use Monolog\Handler\TestHandler;
use Monolog\Logger;
use PHPUnit\Framework\TestCase;

/**
 * settleTopup / failTopup offline, on a scripted EntityManager (audit M2).
 *
 * Each test hands the service two views of the same entry: the copy this
 * request loaded earlier (what the old code trusted — "pending"), and what the
 * database returns to the locked re-read. The decision must follow the locked
 * re-read, and the compare-and-set UPDATE's row count must decide the winner.
 * (The same race against a real Postgres: tests/Integration/Wallet.)
 */
final class WalletSettlementTest extends TestCase
{
    /** @var list<object> */
    private array $persisted = [];

    /** @var list<array{0:string,1:list<mixed>}> */
    private array $statements = [];

    /** @var list<array{0:string,1:mixed}> */
    private array $locks = [];

    private int $casRows = 1;

    private TestHandler $mail;

    private Wallet $wallet;

    private function topup(string $status = WalletTransaction::STATUS_PENDING): WalletTransaction
    {
        $txn = new WalletTransaction($this->wallet->getId(), 'p-1', WalletTransaction::TYPE_TOPUP, WalletTransaction::DIR_CREDIT, '5000.00', 'NGN', 'vmw_ref', $status);
        (new \ReflectionProperty(WalletTransaction::class, 'id'))->setValue($txn, '11111111-1111-4111-8111-111111111111');

        return $txn;
    }

    private string|false $errorLog = false;

    protected function setUp(): void
    {
        $this->wallet = new Wallet('p-1', 'NGN');
        $this->wallet->setBalance('1000.00');
        $this->mail = new TestHandler();
        // The "HELD for review" operational log line is expected; keep it out of the output.
        $this->errorLog = ini_set('error_log', sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'wallet-unit-error.log');
    }

    protected function tearDown(): void
    {
        if ($this->errorLog !== false) {
            ini_set('error_log', $this->errorLog);
        }
    }

    /** A WalletService whose "database" holds `$current` while this request still has `$requestCopy`. */
    private function service(WalletTransaction $requestCopy, WalletTransaction $current): WalletService
    {
        $persister = $this->createMock(EntityPersister::class);
        $persister->method('load')->willReturn($requestCopy); // byReference(): the identity-map copy
        $uow = $this->createMock(UnitOfWork::class);
        $uow->method('getEntityPersister')->willReturn($persister);

        $conn = $this->createMock(Connection::class);
        $conn->method('executeStatement')->willReturnCallback(function (string $sql, array $params = []): int {
            $this->statements[] = [$sql, $params];

            return $this->casRows;
        });

        $em = $this->createMock(EntityManagerInterface::class);
        $em->method('getUnitOfWork')->willReturn($uow);
        $em->method('getConnection')->willReturn($conn);
        $em->method('getClassMetadata')->willReturnCallback(static function (string $class): ClassMetadata {
            $meta = new ClassMetadata($class);
            $meta->setPrimaryTable(['name' => 'wallet_transactions']);

            return $meta;
        });
        $em->method('wrapInTransaction')->willReturnCallback(static fn (callable $fn): mixed => $fn());
        $em->method('persist')->willReturnCallback(function (object $o): void {
            $this->persisted[] = $o;
        });
        $em->method('find')->willReturnCallback(function (string $class, mixed $id, mixed $lockMode = null) use ($current): ?object {
            if ($class === Wallet::class || $class === WalletTransaction::class) {
                $this->locks[] = [$class, $lockMode];
            }

            return match ($class) {
                Wallet::class            => $this->wallet,
                WalletTransaction::class => $current,
                default                  => null, // no patient: receipt/notice are skipped quietly
            };
        });

        $patients = new PatientRepository($em);

        return new WalletService(
            $em,
            new WalletRepository($em),
            new WalletTransactionRepository($em),
            new WalletMailer($patients, new MailService('', '', '', '', new Logger('mail', [$this->mail]))),
            new NotificationRepository($em),
            $patients,
        );
    }

    /** @return list<string> */
    private function audited(): array
    {
        return array_values(array_map(
            static fn (AuditEvent $e): string => (string) $e->toArray()['action'],
            array_filter($this->persisted, static fn (object $o): bool => $o instanceof AuditEvent),
        ));
    }

    public function testAStaleCopyNeverCreditsWhatTheDatabaseSaysIsPosted(): void
    {
        // This request read "pending" before its gateway call; meanwhile another
        // request credited it. The old code trusted the stale copy and credited again.
        $stale   = $this->topup();
        $current = $this->topup(WalletTransaction::STATUS_SUCCESS);

        $this->assertNull($this->service($stale, $current)->settleTopup('vmw_ref', '500000', 'NGN'));
        $this->assertSame('1000.00', $this->wallet->getBalance(), 'not credited again');
        $this->assertSame([], $this->statements, 'nothing written');
        $this->assertSame([], $this->audited());
        $this->assertSame([[Wallet::class, LockMode::PESSIMISTIC_WRITE], [WalletTransaction::class, LockMode::PESSIMISTIC_WRITE]], $this->locks, 'wallet row, then ledger row, both locked + re-read');
    }

    public function testTheCompareAndSetRowCountDecides(): void
    {
        $this->casRows = 0; // another session flipped the status first
        $entry         = $this->topup();

        $this->assertNull($this->service($entry, $entry)->settleTopup('vmw_ref', '500000', 'NGN'));
        $this->assertSame('1000.00', $this->wallet->getBalance());
        $this->assertTrue($entry->isPending(), 'the loser leaves the entry alone');
        $this->assertSame([], $this->audited());
        $this->assertCount(1, $this->statements);
        [$sql, $params] = $this->statements[0];
        $this->assertSame(
            'UPDATE wallet_transactions SET status = ? WHERE id = ? AND status IN (?, ?) AND posted_at IS NULL AND balance_after IS NULL',
            $sql,
            'the row must still be open AND never have posted',
        );
        $this->assertSame([WalletTransaction::STATUS_SUCCESS, $entry->getId(), WalletTransaction::STATUS_PENDING, WalletTransaction::STATUS_FAILED], $params);
    }

    /**
     * Review finding (High): the pre-fix late-failure race left rows `failed`
     * AFTER they were credited (posted_at/balance_after set, money in the
     * wallet). `failed` alone must not reopen them for a second credit.
     */
    public function testACreditedRowLeftFailedByTheOldRaceIsNeverCreditedAgain(): void
    {
        $leftFailed = $this->topup();
        $leftFailed->markPosted('6000.00', 'paystack', 'gw_old');
        (new \ReflectionProperty(WalletTransaction::class, 'status'))->setValue($leftFailed, WalletTransaction::STATUS_FAILED); // the stale flush

        $this->assertNull($this->service($leftFailed, $leftFailed)->settleTopup('vmw_ref', '500000', 'NGN', 'gw_new'));
        $this->assertSame('1000.00', $this->wallet->getBalance(), 'not credited a second time');
        $this->assertSame(WalletTransaction::STATUS_FAILED, $leftFailed->getStatus(), 'left for support to restore');
        $this->assertSame('6000.00', $leftFailed->getBalanceAfter());
        $this->assertSame('gw_old', $leftFailed->getProviderReference());
        $this->assertSame([], $this->statements, 'no compare-and-set attempted');
        $this->assertSame(['wallet.topup_settle_refused_already_posted'], $this->audited(), 'the refusal is audited');
        $this->assertSame(0, count($this->mail->getRecords()), 'no receipt');

        // …and a late "charge failed" doesn't touch it either.
        $this->persisted = [];
        $this->assertFalse($this->service($leftFailed, $leftFailed)->failTopup('vmw_ref'));
        $this->assertSame([], $this->audited());
    }

    public function testAHeldPaymentRecordsTheGatewayFiguresButNeverDecidesOnThem(): void
    {
        $entry = $this->topup();
        $this->assertNull($this->service($entry, $entry)->settleTopup('vmw_ref', '100', 'NGN', 'gw_1', ['gross_amount_minor' => 101, 'fees_minor' => '1', 'requested_amount_minor' => 'x', 'other' => '9']));
        $this->assertSame(['reason', 'expected_amount_minor', 'expected_currency', 'verified_amount_minor', 'verified_currency', 'gross_amount_minor', 'fees_minor', 'held_at'], array_keys($entry->getMetadata()['review']));
        $this->assertSame('101', $entry->getMetadata()['review']['gross_amount_minor'], 'digits kept as strings; junk dropped');
    }

    public function testTheWinnerCreditsOnceAndAuditsInTheSameTransaction(): void
    {
        $entry  = $this->topup();
        $posted = $this->service($entry, $entry)->settleTopup('vmw_ref', '500000', 'NGN', 'gw_1');

        $this->assertSame($entry, $posted);
        $this->assertSame('6000.00', $this->wallet->getBalance());
        $this->assertTrue($entry->isSuccess());
        $this->assertSame('6000.00', $entry->getBalanceAfter());
        $this->assertSame('500000', $entry->getMetadata()['verified_amount_minor']);
        $this->assertArrayNotHasKey('gateway', $entry->getMetadata(), 'no gateway figures given, none stored');
        $this->assertSame(['wallet.topup_credited'], $this->audited());
    }

    public function testTheWinnerKeepsTheGatewayFigures(): void
    {
        $entry = $this->topup();
        $this->service($entry, $entry)->settleTopup('vmw_ref', '500000', 'NGN', 'gw_1', ['gross_amount_minor' => 507500, 'fees_minor' => 7500, 'requested_amount_minor' => 500000]);

        $this->assertSame('6000.00', $this->wallet->getBalance(), "the customer's fee is not credited");
        $this->assertSame(['gross_amount_minor' => '507500', 'fees_minor' => '7500', 'requested_amount_minor' => '500000'], $entry->getMetadata()['gateway']);
    }

    public function testAWrongAmountIsHeldNotCredited(): void
    {
        $entry = $this->topup();

        $this->assertNull($this->service($entry, $entry)->settleTopup('vmw_ref', '100', 'NGN', 'gw_1'));
        $this->assertSame('1000.00', $this->wallet->getBalance());
        $this->assertTrue($entry->needsReview());
        $this->assertSame(['wallet.topup_held_for_review'], $this->audited());
        $this->assertSame(WalletTransaction::STATUS_REVIEW, $this->statements[0][1][0], 'held by compare-and-set too');
        $this->assertSame(0, count($this->mail->getRecords()), 'no receipt');
    }

    public function testALateFailureNeverDowngradesAPostedTopup(): void
    {
        $stale   = $this->topup();
        $current = $this->topup(WalletTransaction::STATUS_SUCCESS);

        $this->assertFalse($this->service($stale, $current)->failTopup('vmw_ref'));
        $this->assertTrue($current->isSuccess());
        $this->assertSame([], $this->audited());
    }

    public function testOnlyTopupsSettle(): void
    {
        $refund = new WalletTransaction($this->wallet->getId(), 'p-1', WalletTransaction::TYPE_REFUND, WalletTransaction::DIR_CREDIT, '5.00', 'NGN', 'refund_x');

        $this->expectException(\RuntimeException::class);
        $this->service($refund, $refund)->settleTopup('refund_x', '500', 'NGN');
    }
}
