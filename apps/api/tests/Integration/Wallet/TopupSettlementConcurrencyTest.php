<?php

declare(strict_types=1);

namespace App\Tests\Integration\Wallet;

use App\Domain\Entity\WalletTransaction;
use App\Tests\Integration\Wallet\Support\WalletHarness;

/**
 * Audit M2 — the wallet top-up double-credit race, against a real Postgres.
 *
 * The bug: the verify action and the webhook each loaded the pending entry,
 * spent hundreds of milliseconds on Paystack, then settled using that stale
 * in-memory copy; only the wallet row was locked, so every request that had
 * read "pending" credited the top-up again. These tests recreate exactly that
 * interleaving with separate database sessions (and separate OS processes) and
 * prove the top-up is credited once, with one receipt, one notice, one audit.
 */
final class TopupSettlementConcurrencyTest extends WalletIntegrationTestCase
{
    public function testTwoRequestsHoldingStaleCopiesCreditOnce(): void
    {
        [$patientId, $reference] = $this->pendingTopup('5000.00');

        // Two "requests", each its own session, both read the entry as pending.
        $emA = $this->em();
        $emB = $this->em();
        $this->assertTrue($this->load($emA, $reference)->isPending());
        $this->assertTrue($this->load($emB, $reference)->isPending());
        [$walletsA, $mailA] = $this->walletService($emA);
        [$walletsB, $mailB] = $this->walletService($emB);

        // A settles and commits; B still holds its stale "pending" copy.
        $this->assertNotNull($walletsA->settleTopup($reference, '500000', 'NGN', 'gw_a'));
        $this->assertNull($walletsB->settleTopup($reference, '500000', 'NGN', 'gw_b'), 'the second settle must not credit again');

        $this->assertSame('5000.00', $this->balanceOf($patientId));
        $this->assertSame('5000.00', $this->ledgerOf($patientId));
        $this->assertSame(1, WalletHarness::receipts($mailA) + WalletHarness::receipts($mailB), 'one receipt');
        $this->assertSame(1, $this->notificationCount($patientId, 'Wallet funded'), 'one notice');
        $this->assertSame(1, $this->auditCount('wallet.topup_credited', $reference), 'one audit event');
        $this->assertSame(WalletTransaction::STATUS_SUCCESS, $this->load($emB, $reference)->getStatus(), "B's copy was refreshed by the locked re-read");
        $row = $this->row('SELECT balance_after, provider_reference FROM wallet_transactions WHERE reference = ?', [$reference]);
        $this->assertSame('5000.00', $row['balance_after']);
        $this->assertSame('gw_a', $row['provider_reference'], "the loser didn't touch the posted entry");
    }

    public function testParallelSettlesQueuedOnTheLockCreditOnce(): void
    {
        [$patientId, $reference] = $this->pendingTopup('2500.00');
        $walletId                = (string) $this->row('SELECT id FROM wallets WHERE patient_id = ?', [$patientId])['id'];
        $app                     = 'wallet_it_settle_' . bin2hex(random_bytes(3));

        // Hold the wallet row so every worker loads its (stale) copy and then
        // queues on the lock at the same point — the race window, held open.
        $control = $this->em();
        $control->getConnection()->beginTransaction();
        $control->getConnection()->fetchOne('SELECT id FROM wallets WHERE id = ? FOR UPDATE', [$walletId]);

        $workers = [];
        for ($i = 0; $i < 5; ++$i) {
            $workers[] = WalletHarness::startWorker([
                'schema'       => static::$schema,
                'app'          => $app,
                'op'           => 'settle',
                'reference'    => $reference,
                'amount_minor' => '250000',
                'currency'     => 'NGN',
            ]);
        }
        try {
            WalletHarness::awaitLockWaiters($this->em(), $app, 5);
        } finally {
            $control->getConnection()->commit(); // release: all five race for it now
        }

        $results = array_map([WalletHarness::class, 'finishWorker'], $workers);
        foreach ($results as $result) {
            $this->assertNull($result['error'], (string) $result['error']);
        }
        $this->assertSame(1, count(array_filter($results, static fn (array $r): bool => $r['posted'])), 'exactly one worker credits');
        $this->assertSame(1, array_sum(array_column($results, 'receipts')), 'exactly one receipt');
        $this->assertSame('2500.00', $this->balanceOf($patientId));
        $this->assertSame('2500.00', $this->ledgerOf($patientId));
        $this->assertSame(1, $this->notificationCount($patientId, 'Wallet funded'));
        $this->assertSame(1, $this->auditCount('wallet.topup_credited', $reference));
    }

    public function testAFailureReportedLateNeverUndoesACredit(): void
    {
        [$patientId, $reference] = $this->pendingTopup('1000.00');
        $emStale = $this->em();
        $this->assertTrue($this->load($emStale, $reference)->isPending());

        [$wallets] = $this->walletService($this->em());
        $this->assertNotNull($wallets->settleTopup($reference, '100000', 'NGN'));

        // A request that saw "pending" earlier now reports the charge failed.
        [$staleWallets] = $this->walletService($emStale);
        $this->assertFalse($staleWallets->failTopup($reference));
        $this->assertSame(WalletTransaction::STATUS_SUCCESS, $this->statusOf($reference), 'never downgraded (which would reopen it for a second credit)');

        // …so nothing can credit it again either.
        $this->assertNull($staleWallets->settleTopup($reference, '100000', 'NGN'));
        $this->assertSame('1000.00', $this->balanceOf($patientId));
    }

    public function testAFailedTopupPaidLaterIsCreditedOnce(): void
    {
        [$patientId, $reference] = $this->pendingTopup('750.00');
        [$wallets]               = $this->walletService($this->em());
        $this->assertTrue($wallets->failTopup($reference));
        $this->assertSame(WalletTransaction::STATUS_FAILED, $this->statusOf($reference));

        [$a] = $this->walletService($this->em());
        [$b] = $this->walletService($this->em());
        $this->assertNotNull($a->settleTopup($reference, '75000', 'NGN'));
        $this->assertNull($b->settleTopup($reference, '75000', 'NGN'));
        $this->assertSame('750.00', $this->balanceOf($patientId));
        $this->assertSame(1, $this->auditCount('wallet.topup_failed', $reference));
    }

    public function testParallelCreditsWithOneReferencePostOnce(): void
    {
        $patientId = WalletHarness::seedPatient($this->em());
        [$wallets] = $this->walletService($this->em());
        $wallets->credit($patientId, 'NGN', '100.00', WalletTransaction::TYPE_REFUND, 'it_seed_' . bin2hex(random_bytes(4)), null, false);
        $walletId  = (string) $this->row('SELECT id FROM wallets WHERE patient_id = ?', [$patientId])['id'];
        $reference = 'refund_it_' . bin2hex(random_bytes(6));
        $app       = 'wallet_it_credit_' . bin2hex(random_bytes(3));

        $control = $this->em();
        $control->getConnection()->beginTransaction();
        $control->getConnection()->fetchOne('SELECT id FROM wallets WHERE id = ? FOR UPDATE', [$walletId]);
        $workers = [];
        for ($i = 0; $i < 3; ++$i) {
            $workers[] = WalletHarness::startWorker([
                'schema'     => static::$schema,
                'app'        => $app,
                'op'         => 'credit',
                'reference'  => $reference,
                'patient_id' => $patientId,
                'amount'     => '400.00',
            ]);
        }
        try {
            WalletHarness::awaitLockWaiters($this->em(), $app, 3);
        } finally {
            $control->getConnection()->commit();
        }

        $results = array_map([WalletHarness::class, 'finishWorker'], $workers);
        foreach ($results as $result) {
            $this->assertNull($result['error'], 'an idempotent retry answers with the posted entry instead of failing: ' . $result['error']);
        }
        $this->assertSame(1, array_sum(array_column($results, 'receipts')), 'one receipt');
        $this->assertSame('500.00', $this->balanceOf($patientId), 'credited once');
        $this->assertSame('500.00', $this->ledgerOf($patientId));
        $this->assertSame(1, (int) $this->em()->getConnection()->fetchOne('SELECT COUNT(*) FROM wallet_transactions WHERE reference = ?', [$reference]));
        $this->assertSame(1, $this->auditCount('wallet.credited', $reference));
    }
}
