<?php

declare(strict_types=1);

namespace App\Tests\Integration\Wallet;

use App\Domain\Entity\WalletTransaction;
use App\Domain\Repository\WalletTransactionRepository;
use App\Infrastructure\Service\PaystackService;
use App\Infrastructure\Service\WalletTopupSweeper;
use App\Tests\Integration\Wallet\Support\WalletHarness;

/**
 * Money review finding (Medium): top-ups paid but never credited (the pre-fix
 * verify marked not-yet-successful payments `failed`, the pre-fix webhook only
 * settled pending ones, and Paystack doesn't resend). bin/wallet-topup-sweep.php
 * asks Paystack about every never-credited pending/failed top-up and credits
 * the paid ones through settleTopup — once, exact amount — and touches nothing
 * else. Real Postgres + the LOCAL fake Paystack (nothing reaches Paystack).
 */
final class TopupSweepTest extends WalletIntegrationTestCase
{
    /** @var array{process: resource, dir: string, port: int, url: string}|null */
    private static ?array $fake = null;

    public static function setUpBeforeClass(): void
    {
        parent::setUpBeforeClass();
        if (static::$schema !== null) {
            self::$fake = WalletHarness::startFakePaystack();
        }
    }

    public static function tearDownAfterClass(): void
    {
        WalletHarness::stopFakePaystack(self::$fake);
        self::$fake = null;
        parent::tearDownAfterClass();
    }

    protected function tearDown(): void
    {
        if (static::$schema !== null) {
            $this->em()->getConnection()->executeStatement('TRUNCATE wallet_transactions, wallets');
        }
        parent::tearDown();
    }

    public function testDryRunChangesNothingThenRunCreditsOnlyThePaidOnesOnce(): void
    {
        // A failed one paid later, a pending one Paystack confirms, a wrong amount,
        // an abandoned checkout, one still processing — all an hour old.
        [$p1, $failedPaid] = $this->pendingTopup('300.00');
        [$wallets]         = $this->walletService($this->em());
        $this->assertTrue($wallets->failTopup($failedPaid));
        [$p2, $pendingPaid] = $this->pendingTopup('2000.00');
        [$p3, $wrong]       = $this->pendingTopup('5000.00');
        [$p4, $abandoned]   = $this->pendingTopup('700.00');
        [$p5, $ongoing]     = $this->pendingTopup('800.00');
        WalletHarness::paystackSays(self::$fake['dir'], $failedPaid, 'success', 30000);
        WalletHarness::paystackSays(self::$fake['dir'], $pendingPaid, 'success', 201500, 'NGN', ['requested_amount' => 200000, 'fees' => 1500]);
        WalletHarness::paystackSays(self::$fake['dir'], $wrong, 'success', 100);
        WalletHarness::paystackSays(self::$fake['dir'], $abandoned, 'abandoned', 70000);
        WalletHarness::paystackSays(self::$fake['dir'], $ongoing, 'ongoing', 80000);

        // Never candidates: one that moved money (old race), one held, one credited, one too young.
        [$p6, $postedFailed] = $this->pendingTopup('900.00');
        [$wallets]           = $this->walletService($this->em());
        $wallets->settleTopup($postedFailed, '90000', 'NGN');
        $this->leaveFailedAfterCredit($postedFailed);
        [, $held] = $this->pendingTopup('100.00');
        $wallets->settleTopup($held, '1', 'NGN');
        [, $young] = $this->pendingTopup('400.00');
        foreach ([$failedPaid, $pendingPaid, $wrong, $abandoned, $ongoing, $postedFailed, $held] as $reference) {
            $this->age($reference, '1 hour');
        }
        WalletHarness::paystackSays(self::$fake['dir'], $postedFailed, 'success', 90000);
        WalletHarness::paystackSays(self::$fake['dir'], $young, 'success', 40000);

        // Dry run: asks Paystack, writes nothing.
        $before = $this->fingerprint();
        $dry    = $this->sweeper()->sweep(false, 15, 30, 1000, 0);
        $this->assertSame($before, $this->fingerprint(), 'a dry run changes nothing');
        $this->assertFalse($dry['apply']);
        $this->assertSame(5, $dry['candidates']);
        $this->assertOutcomes([
            $abandoned   => 'not_paid',
            $failedPaid  => 'would_credit',
            $ongoing     => 'still_processing',
            $pendingPaid => 'would_credit',
            $wrong       => 'would_hold_for_review',
        ], $this->outcomes($dry));
        foreach ([$postedFailed, $held, $young] as $untouched) {
            $this->assertSame(0, WalletHarness::gatewayCalls(self::$fake['dir'], $untouched), 'never asked about ' . $untouched);
        }

        // Applying.
        $applied = $this->sweeper()->sweep(true, 15, 30, 1000, 0);
        $this->assertNull($applied['stopped']);
        $this->assertOutcomes([
            $abandoned   => 'not_paid',
            $failedPaid  => 'credited',
            $ongoing     => 'still_processing',
            $pendingPaid => 'credited',
            $wrong       => 'held_for_review',
        ], $this->outcomes($applied));
        $this->assertSame('300.00', $this->balanceOf($p1));
        $this->assertSame('2000.00', $this->balanceOf($p2), 'the fee the customer paid is not credited');
        $this->assertSame('0.00', $this->balanceOf($p3));
        $this->assertSame(WalletTransaction::STATUS_REVIEW, $this->statusOf($wrong));
        $this->assertSame('0.00', $this->balanceOf($p4));
        $this->assertSame(WalletTransaction::STATUS_PENDING, $this->statusOf($abandoned), 'nothing is marked failed by the sweep');
        $this->assertSame(WalletTransaction::STATUS_PENDING, $this->statusOf($ongoing));
        $this->assertSame('900.00', $this->balanceOf($p6), 'the old-race row is not credited again');
        $this->assertSame(1, $this->notificationCount($p1, 'Wallet funded'));
        $this->assertSame(1, $this->notificationCount($p3, 'Top-up under review'), 'told honestly');

        // Again: only the still-open ones are asked about; nothing is credited twice.
        $again = $this->sweeper()->sweep(true, 15, 30, 1000, 0);
        $this->assertOutcomes([$abandoned => 'not_paid', $ongoing => 'still_processing'], $this->outcomes($again));
        $this->assertSame('300.00', $this->balanceOf($p1));
        $this->assertSame('2000.00', $this->balanceOf($p2));
        $this->assertSame(1, $this->auditCount('wallet.topup_credited', $failedPaid));
        $this->assertSame(1, $this->auditCount('wallet.topup_credited', $pendingPaid));
    }

    public function testAWebhookCreditingDuringTheSweepIsNotDoubled(): void
    {
        [$patientId, $reference] = $this->pendingTopup('1500.00');
        $this->age($reference, '1 hour');
        WalletHarness::paystackSays(self::$fake['dir'], $reference, 'success', 150000);
        WalletHarness::settleDuringNextVerify(self::$fake['dir'], (string) static::$schema, $reference, '150000');

        $result = $this->sweeper()->sweep(true, 15, 30, 1000, 0);
        $this->assertOutcomes([$reference => 'already_settled'], $this->outcomes($result));
        $this->assertSame('1500.00', $this->balanceOf($patientId));
        $this->assertSame(1, $this->auditCount('wallet.topup_credited', $reference));
        $this->assertSame(1, $this->notificationCount($patientId, 'Wallet funded'));
    }

    public function testTheAgeWindowAndTheBackfill(): void
    {
        [$patientId, $reference] = $this->pendingTopup('250.00');
        $this->age($reference, '90 days');
        WalletHarness::paystackSays(self::$fake['dir'], $reference, 'success', 25000);

        $this->assertSame(0, $this->sweeper()->sweep(true, 15, 30, 1000, 0)['candidates'], 'outside the nightly window');
        $backfill = $this->sweeper()->sweep(true, 15, 0, 1000, 0); // --max-age-days=0
        $this->assertOutcomes([$reference => 'credited'], $this->outcomes($backfill));
        $this->assertSame('250.00', $this->balanceOf($patientId));
    }

    public function testAnUnreachablePaystackChangesNothingAndIsReported(): void
    {
        [$patientId, $reference] = $this->pendingTopup('250.00');
        $this->age($reference, '1 hour');
        // Nothing listens on the discard port: Paystack can't be asked at all.
        $result = $this->sweeper('http://127.0.0.1:9')->sweep(true, 15, 30, 1000, 0);
        $this->assertOutcomes([$reference => 'gateway_error'], $this->outcomes($result));
        $this->assertSame(WalletTransaction::STATUS_PENDING, $this->statusOf($reference));
        $this->assertSame('0.00', $this->balanceOf($patientId));
    }

    public function testATopUpPaystackHasNoTransactionForIsNotPaidAndKeepsTheNightlyRunGreen(): void
    {
        // Paystack's initialize failed (FundWalletAction marks it failed), so
        // Paystack has nothing under the reference: "not found" is a definite
        // "nothing paid", not an error that fails every nightly run for 30 days.
        [$patientId, $failed] = $this->pendingTopup('250.00');
        [$wallets]            = $this->walletService($this->em());
        $this->assertTrue($wallets->failTopup($failed));
        [$p2, $pending] = $this->pendingTopup('400.00');
        $this->age($failed, '1 hour');
        $this->age($pending, '1 hour');
        // no scripted answer → the fake answers 400 "Transaction reference not found", as Paystack does

        $before = $this->fingerprint();
        $result = $this->sweeper()->sweep(true, 15, 30, 1000, 0);
        $this->assertNull($result['stopped']);
        $this->assertOutcomes([$failed => 'not_paid', $pending => 'not_paid'], $this->outcomes($result));
        $this->assertSame($before, $this->fingerprint(), 'nothing changed');
        $this->assertSame(WalletTransaction::STATUS_FAILED, $this->statusOf($failed));
        $this->assertSame(WalletTransaction::STATUS_PENDING, $this->statusOf($pending), 'nothing is marked failed by the sweep');
        $this->assertSame('0.00', $this->balanceOf($patientId));
        $this->assertSame('0.00', $this->balanceOf($p2));

        $env = [
            'PAYSTACK_SECRET_KEY' => 'sk_test_local_fake',
            'PAYSTACK_PUBLIC_KEY' => 'pk_test_local_fake',
            'PAYSTACK_BASE_URL'   => self::$fake['url'],
        ];
        foreach ([['--pause-ms=0'], ['--run', '--pause-ms=0']] as $args) {
            [$exit, $out] = $this->runCommand('bin/wallet-topup-sweep.php', $args, $env);
            $this->assertSame(0, $exit, $out);
            $this->assertStringContainsString('not_paid 2', $out);
            $this->assertStringNotContainsString('gateway_error', $out);
        }
    }

    public function testTheCommandIsADryRunUnlessToldToRun(): void
    {
        [$patientId, $reference] = $this->pendingTopup('600.00');
        $this->age($reference, '1 hour');
        WalletHarness::paystackSays(self::$fake['dir'], $reference, 'success', 60000);
        $env = [
            'PAYSTACK_SECRET_KEY' => 'sk_test_local_fake',
            'PAYSTACK_PUBLIC_KEY' => 'pk_test_local_fake',
            'PAYSTACK_BASE_URL'   => self::$fake['url'],
        ];

        $before        = $this->fingerprint();
        [$exit, $out]  = $this->runCommand('bin/wallet-topup-sweep.php', ['--pause-ms=0'], $env);
        $this->assertSame(1, $exit, $out);
        $this->assertStringContainsString('DRY RUN', $out);
        $this->assertStringContainsString('would_credit', $out);
        $this->assertSame($before, $this->fingerprint());

        [$exit, $out] = $this->runCommand('bin/wallet-topup-sweep.php', ['--run', '--pause-ms=0'], $env);
        $this->assertSame(0, $exit, $out);
        $this->assertStringContainsString('credited', $out);
        $this->assertSame('600.00', $this->balanceOf($patientId));

        [$exit, $out] = $this->runCommand('bin/wallet-topup-sweep.php', ['--bogus'], $env);
        $this->assertSame(2, $exit, $out);
    }

    /** A sweeper asking the local fake Paystack — or `$paystackUrl` instead. */
    private function sweeper(?string $paystackUrl = null): WalletTopupSweeper
    {
        $em        = $this->em();
        [$wallets] = $this->walletService($em);

        return new WalletTopupSweeper(
            $em,
            $wallets,
            new WalletTransactionRepository($em),
            new PaystackService('sk_test_local_fake', 'pk_test_local_fake', $paystackUrl ?? self::$fake['url']),
        );
    }

    /** @param array<string,mixed> $report @return array<string,string> reference => outcome, sorted */
    private function outcomes(array $report): array
    {
        $out = array_column($report['results'], 'outcome', 'reference');
        ksort($out);

        return $out;
    }

    /** @param array<string,string> $expected @param array<string,string> $actual */
    private function assertOutcomes(array $expected, array $actual): void
    {
        ksort($expected);
        $this->assertSame($expected, $actual);
    }
}
