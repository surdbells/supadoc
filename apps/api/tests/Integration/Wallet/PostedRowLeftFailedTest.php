<?php

declare(strict_types=1);

namespace App\Tests\Integration\Wallet;

use App\Domain\Entity\WalletTransaction;
use App\Tests\Integration\Wallet\Support\WalletHarness;

/**
 * Money review finding (High), against a real Postgres: the pre-fix
 * late-failure race left top-ups `failed` AFTER crediting them (verify loaded
 * the pending entry, Paystack said not-success, the webhook credited it
 * meanwhile, then verify's stale flush rewrote only `status`). posted_at,
 * balance_after and provider_reference stayed set and the wallet holds the
 * money. Those rows must never be credited again, the reconciler must name
 * them (not a later, legitimate top-up), and support's fix is a status restore
 * that moves no money.
 */
final class PostedRowLeftFailedTest extends WalletIntegrationTestCase
{
    protected function tearDown(): void
    {
        if (static::$schema !== null) {
            // Each test starts from an empty ledger (the reconciler test asserts on the whole schema).
            $this->em()->getConnection()->executeStatement('TRUNCATE wallet_transactions, wallets');
        }
        parent::tearDown();
    }

    /** A ₦5,000 top-up credited and then left `failed`; returns [patientId, reference]. @return array{0:string,1:string} */
    private function creditedThenLeftFailed(): array
    {
        [$patientId, $reference] = $this->pendingTopup('5000.00');
        [$wallets]               = $this->walletService($this->em());
        $this->assertNotNull($wallets->settleTopup($reference, '500000', 'NGN', 'gw_first'));
        $this->leaveFailedAfterCredit($reference);

        return [$patientId, $reference];
    }

    public function testItIsNeverCreditedAgain(): void
    {
        [$patientId, $reference] = $this->creditedThenLeftFailed();

        // The patient reopens the callback URL / a webhook arrives / a retry.
        foreach ([1, 2] as $_) {
            [$wallets, $mail] = $this->walletService($this->em());
            $this->assertNull($wallets->settleTopup($reference, '500000', 'NGN', 'gw_again'));
            $this->assertSame(0, WalletHarness::receipts($mail), 'no receipt');
        }
        [$wallets] = $this->walletService($this->em());
        $this->assertFalse($wallets->failTopup($reference));

        $this->assertSame('5000.00', $this->balanceOf($patientId), 'still credited exactly once');
        $this->assertSame(WalletTransaction::STATUS_FAILED, $this->statusOf($reference), 'left for support');
        $row = $this->row('SELECT balance_after, provider_reference FROM wallet_transactions WHERE reference = ?', [$reference]);
        $this->assertSame('5000.00', $row['balance_after']);
        $this->assertSame('gw_first', $row['provider_reference']);
        $this->assertSame(2, $this->auditCount('wallet.topup_settle_refused_already_posted', $reference), 'each refusal audited');
        $this->assertSame(1, $this->notificationCount($patientId, 'Wallet funded'));
    }

    public function testParallelSettlesOfSuchARowCreditNothing(): void
    {
        [$patientId, $reference] = $this->creditedThenLeftFailed();
        $walletId                = (string) $this->row('SELECT id FROM wallets WHERE patient_id = ?', [$patientId])['id'];
        $app                     = 'wallet_it_posted_' . bin2hex(random_bytes(3));

        $control = $this->em();
        $control->getConnection()->beginTransaction();
        $control->getConnection()->fetchOne('SELECT id FROM wallets WHERE id = ? FOR UPDATE', [$walletId]);
        $workers = [];
        for ($i = 0; $i < 3; ++$i) {
            $workers[] = WalletHarness::startWorker([
                'schema'       => static::$schema,
                'app'          => $app,
                'op'           => 'settle',
                'reference'    => $reference,
                'amount_minor' => '500000',
                'currency'     => 'NGN',
            ]);
        }
        try {
            WalletHarness::awaitLockWaiters($this->em(), $app, 3);
        } finally {
            $control->getConnection()->commit();
        }

        $results = array_map([WalletHarness::class, 'finishWorker'], $workers);
        foreach ($results as $result) {
            $this->assertNull($result['error'], (string) $result['error']);
            $this->assertFalse($result['posted']);
        }
        $this->assertSame('5000.00', $this->balanceOf($patientId));
        $this->assertSame(1, $this->auditCount('wallet.topup_credited', $reference));
    }

    public function testTheReconcilerNamesItNotALaterLegitimateTopupAndSupportRestoresIt(): void
    {
        [$patientId, $old] = $this->creditedThenLeftFailed();
        $this->age($old, '3 days'); // also old enough for the "stale" info list — it must not be there
        // Later, a real ₦5,000 top-up the patient paid for.
        [$wallets] = $this->walletService($this->em());
        $legit     = 'vmw_it_' . bin2hex(random_bytes(8));
        $wallets->beginTopup($patientId, 'NGN', '5000.00', $legit);
        $wallets->settleTopup($legit, '500000', 'NGN', 'gw_legit');
        $this->assertSame('10000.00', $this->balanceOf($patientId));
        $this->assertSame('5000.00', $this->ledgerOf($patientId));

        $before = $this->fingerprint();
        $report = $this->reconcile();
        $this->assertSame($before, $this->fingerprint(), 'read-only');
        $this->assertSame([], $this->findingsOf($report, 'repeat_credit_suspected'), 'the legitimate top-up is NOT accused');
        $posted = $this->findingsOf($report, 'posted_entry_not_success');
        $this->assertCount(1, $posted);
        $this->assertSame($old, $posted[0]['reference']);
        $this->assertStringContainsString('restorePostedTopup', $posted[0]['summary']);
        $mismatch = $this->findingsOf($report, 'balance_mismatch');
        $this->assertCount(1, $mismatch);
        $this->assertSame('5000.00', $mismatch[0]['difference']);
        $this->assertSame([$old], $mismatch[0]['unrestored']);
        $this->assertSame('5000.00', $mismatch[0]['unrestored_total']);
        $this->assertSame([], $mismatch[0]['breaks'], 'the running balance adds up once that row is counted');
        foreach ($report['info'] as $info) {
            foreach ($info['latest'] ?? [] as $line) {
                $this->assertStringNotContainsString($old, $line, 'not listed as "never credited"');
            }
        }

        [$exit, $out] = $this->runCommand('bin/wallet-reconcile.php');
        $this->assertSame(1, $exit, $out);
        $this->assertStringContainsString('[FAIL] Entry that moved money but is not marked success', $out);
        $this->assertStringNotContainsString('looks credited', $out);

        // Recording it as a "discrepancy" (→ clawback) is refused while it is unrestored.
        [$support] = $this->walletService($this->em());
        $walletId  = (string) $this->row('SELECT id FROM wallets WHERE patient_id = ?', [$patientId])['id'];
        try {
            $support->recordLedgerDiscrepancy($walletId, 'looks doubled', 'Support: Ada');
            $this->fail('recorded a discrepancy over an unrestored posted entry');
        } catch (\RuntimeException $e) {
            $this->assertStringContainsString('restorePostedTopup', $e->getMessage());
        }
        $this->assertSame($before, $this->fingerprint(), 'nothing changed by the refusal');

        // Support restores it: status back to success, NO balance change.
        [$support] = $this->walletService($this->em());
        $restored  = $support->restorePostedTopup($old, 'Credited 2026-10-12; old race left it failed', 'Support: Ada');
        $this->assertNotNull($restored);
        $this->assertSame(WalletTransaction::STATUS_SUCCESS, $this->statusOf($old));
        $this->assertSame('10000.00', $this->balanceOf($patientId), 'no money moved');
        $this->assertSame('10000.00', $this->ledgerOf($patientId), 'the ledger counts it again');
        $this->assertSame(1, $this->auditCount('wallet.topup_posted_status_restored', $old));
        $this->assertNull($support->restorePostedTopup($old, 'again', 'Support: Ada'), 'idempotent');

        $this->assertSame([], $this->reconcile()['findings']);
        [$exit, $out] = $this->runCommand('bin/wallet-reconcile.php');
        $this->assertSame(0, $exit, $out);
    }

    public function testTwoSupportRestoresRacingRestoreOnce(): void
    {
        [$patientId, $reference] = $this->creditedThenLeftFailed();
        $emA = $this->em();
        $emB = $this->em();
        $this->assertSame(WalletTransaction::STATUS_FAILED, $this->load($emA, $reference)->getStatus());
        $this->assertSame(WalletTransaction::STATUS_FAILED, $this->load($emB, $reference)->getStatus());
        [$a] = $this->walletService($emA);
        [$b] = $this->walletService($emB);

        $this->assertNotNull($a->restorePostedTopup($reference, 'fix', 'Support: A'));
        $this->assertNull($b->restorePostedTopup($reference, 'fix', 'Support: B'), "B's stale copy is re-read under lock");
        $this->assertSame(1, $this->auditCount('wallet.topup_posted_status_restored', $reference));
        $this->assertSame('5000.00', $this->balanceOf($patientId));
        $this->assertSame('5000.00', $this->ledgerOf($patientId));
    }

    public function testRestoreIsRefusedWhenTheWalletDoesNotHoldTheMoney(): void
    {
        [$patientId, $reference] = $this->creditedThenLeftFailed();
        // e.g. it was already "recovered" by hand before this fix: the balance no longer holds it.
        $this->em()->getConnection()->executeStatement('UPDATE wallets SET balance = 0 WHERE patient_id = ?', [$patientId]);
        $before = $this->fingerprint();

        [$support] = $this->walletService($this->em());
        try {
            $support->restorePostedTopup($reference, 'fix', 'Support: Ada');
            $this->fail('restored money the wallet does not hold');
        } catch (\RuntimeException $e) {
            $this->assertStringContainsString('Nothing was changed', $e->getMessage());
        }
        $this->assertSame($before, $this->fingerprint());
        $this->assertSame(WalletTransaction::STATUS_FAILED, $this->statusOf($reference));
    }
}
