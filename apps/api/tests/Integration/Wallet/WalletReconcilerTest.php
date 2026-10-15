<?php

declare(strict_types=1);

namespace App\Tests\Integration\Wallet;

use App\Domain\Entity\WalletTransaction;
use App\Tests\Integration\Wallet\Support\WalletHarness;

/**
 * bin/wallet-reconcile.php against a real ledger: it finds what the old race
 * left behind (and the other inconsistencies), changes nothing while doing so,
 * exits non-zero until support has corrected the findings through the
 * WalletService methods it points to, then exits 0.
 */
final class WalletReconcilerTest extends WalletIntegrationTestCase
{
    public function testFindsCorruptionChangesNothingAndClearsOnceCorrected(): void
    {
        $this->assertSame([], $this->reconcile()['findings'], 'a fresh schema reconciles');
        $this->assertSame(0, $this->runCommand('bin/wallet-reconcile.php')[0]);

        // 1. What the old race left: one ₦5,000 top-up credited twice (balance and
        //    the entry's balance_after both doubled, still ONE ledger row), then a
        //    ₦1,000 consultation paid out of the inflated balance.
        [$patientId, $doubled] = $this->pendingTopup('5000.00');
        [$wallets]             = $this->walletService($this->em());
        $wallets->settleTopup($doubled, '500000', 'NGN', 'gw_double');
        $walletId = (string) $this->row('SELECT id FROM wallets WHERE patient_id = ?', [$patientId])['id'];
        $raw      = $this->em()->getConnection();
        $raw->executeStatement('UPDATE wallets SET balance = balance + 5000 WHERE id = ?', [$walletId]);
        $raw->executeStatement('UPDATE wallet_transactions SET balance_after = balance_after + 5000 WHERE reference = ?', [$doubled]);
        [$wallets] = $this->walletService($this->em());
        $wallets->debit($patientId, 'NGN', '1000.00', WalletTransaction::TYPE_CONSULTATION, 'appt_it_' . bin2hex(random_bytes(4)));

        // 2. A top-up paid with the wrong amount (held), 3. a row in the wrong
        //    currency for its wallet, 4. one gateway transaction on two credits.
        [$heldPatient, $held] = $this->pendingTopup('2000.00');
        $wallets->settleTopup($held, '1000', 'NGN', 'gw_held');
        $badRef = 'it_bad_' . bin2hex(random_bytes(4));
        $raw->executeStatement(
            "INSERT INTO wallet_transactions (id, wallet_id, patient_id, type, direction, amount, currency, status, reference, created_at, updated_at)
             VALUES (?, ?, ?, 'adjustment', 'credit', 1.00, 'USD', 'pending', ?, NOW(), NOW())",
            [sprintf('%08x-0000-4000-8000-%012x', random_int(0, 0xffffffff), random_int(0, 0xffffffffffff)), $walletId, $patientId, $badRef],
        );
        [$p2, $a] = $this->pendingTopup('10.00');
        [$p3, $b] = $this->pendingTopup('10.00');
        $wallets->settleTopup($a, '1000', 'NGN', 'gw_same');
        $wallets->settleTopup($b, '1000', 'NGN', 'gw_same');

        $before = $this->fingerprint();
        $report = $this->reconcile();
        $this->assertSame($before, $this->fingerprint(), 'the reconciliation changed nothing');
        $kinds = array_count_values(array_column($report['findings'], 'kind'));
        $this->assertSame(1, $kinds['balance_mismatch'] ?? 0);
        $this->assertSame(1, $kinds['repeat_credit_suspected'] ?? 0);
        $this->assertSame(1, $kinds['topup_held_for_review'] ?? 0);
        $this->assertSame(1, $kinds['ledger_anomaly'] ?? 0);
        $this->assertSame(1, $kinds['duplicate_provider_credit'] ?? 0);

        $mismatch = $this->only($report, 'balance_mismatch');
        $this->assertSame($walletId, $mismatch['wallet_id']);
        $this->assertSame('9000.00', $mismatch['balance']);
        $this->assertSame('4000.00', $mismatch['ledger']);
        $this->assertSame('5000.00', $mismatch['difference']);
        $repeat = $this->only($report, 'repeat_credit_suspected');
        $this->assertSame($doubled, $repeat['reference']);
        $this->assertSame(2, $repeat['times']);
        $this->assertSame($held, $this->only($report, 'topup_held_for_review')['reference']);
        $this->assertSame($badRef, $this->only($report, 'ledger_anomaly')['reference']);

        [$exit, $out] = $this->runCommand('bin/wallet-reconcile.php');
        $this->assertSame(1, $exit, $out);
        $this->assertStringContainsString('READ-ONLY', $out);
        $this->assertStringContainsString($doubled . ' looks credited 2 times', $out);
        $this->assertStringContainsString('nothing was changed', $out);
        $this->assertSame($before, $this->fingerprint());

        // Support corrects through the documented paths…
        [$support] = $this->walletService($this->em());
        $recorded  = $support->recordLedgerDiscrepancy($walletId, 'Top-up ' . $doubled . ' credited twice by the M2 race', 'Support: Ada');
        $this->assertNotNull($recorded);
        $this->assertSame('5000.00', $recorded->getAmount());
        $this->assertSame(WalletTransaction::DIR_CREDIT, $recorded->getDirection());
        $this->assertSame('9000.00', $this->balanceOf($patientId), 'recording changes no balance');
        $this->assertNull($support->recordLedgerDiscrepancy($walletId, 'again', 'Support: Ada'), 'idempotent once reconciled');
        // …finance then decides to recover the duplicate (an ordinary, audited debit):
        $support->debit($patientId, 'NGN', '5000.00', WalletTransaction::TYPE_ADJUSTMENT, 'clawback_' . $doubled, 'Duplicate top-up credit recovered');
        $this->assertSame('4000.00', $this->balanceOf($patientId));
        $this->assertSame('4000.00', $this->ledgerOf($patientId));

        $support->resolveHeldTopup($held, null, 'Refunded on Paystack', 'Support: Ada');
        $this->assertSame('0.00', $this->balanceOf($heldPatient));
        // (test-only data: the planted rows go away)
        $raw->executeStatement('DELETE FROM wallet_transactions WHERE reference = ?', [$badRef]);
        $raw->executeStatement("UPDATE wallet_transactions SET provider_reference = 'gw_other' WHERE reference = ?", [$b]);

        $this->assertSame([], $this->reconcile()['findings']);
        [$exit, $out] = $this->runCommand('bin/wallet-reconcile.php');
        $this->assertSame(0, $exit, $out);
        $this->assertStringContainsString('every wallet reconciles', $out);
    }

    public function testAPostedTopupWhoseVerifiedAmountDiffersIsReported(): void
    {
        [$patientId, $reference] = $this->pendingTopup('100.00');
        [$wallets]               = $this->walletService($this->em());
        $wallets->settleTopup($reference, '10000', 'NGN');
        $raw = $this->em()->getConnection();
        $raw->executeStatement(
            "UPDATE wallet_transactions SET metadata = '{\"verified_amount_minor\":\"100\",\"verified_currency\":\"NGN\"}' WHERE reference = ?",
            [$reference],
        );

        $this->assertSame($reference, $this->only($this->reconcile(), 'topup_amount_differs')['reference']);

        // test-only cleanup, so the other test's "fresh schema reconciles" holds in any order
        $raw->executeStatement('DELETE FROM wallet_transactions WHERE patient_id = ?', [$patientId]);
        $raw->executeStatement('DELETE FROM wallets WHERE patient_id = ?', [$patientId]);
    }

    /**
     * Concurrency review finding: the likeliest real trace of the old race —
     * verify credits vmw_x, the app books at once (consultation debit), then
     * the stale webhook credits vmw_x again, overwriting its balance_after /
     * posted_at. The jump lands on the consultation; vmw_x must still be named.
     */
    public function testATopupCreditedTwiceAroundABookingIsNamed(): void
    {
        $patientId = WalletHarness::seedPatient($this->em());
        [$wallets] = $this->walletService($this->em());
        $seed      = 'it_seed_' . bin2hex(random_bytes(4));
        $wallets->credit($patientId, 'NGN', '1000.00', WalletTransaction::TYPE_REFUND, $seed, null, false);
        $topup = 'vmw_it_' . bin2hex(random_bytes(6));
        $wallets->beginTopup($patientId, 'NGN', '5000.00', $topup);
        $wallets->settleTopup($topup, '500000', 'NGN', 'gw_x');
        $consult = 'appt_debit_it_' . bin2hex(random_bytes(4));
        $wallets->debit($patientId, 'NGN', '3000.00', WalletTransaction::TYPE_CONSULTATION, $consult);

        // The stale second credit (what the pre-fix settle did): balance +5000,
        // the top-up's own row overwritten with the new balance and time.
        $raw      = $this->em()->getConnection();
        $walletId = (string) $this->row('SELECT id FROM wallets WHERE patient_id = ?', [$patientId])['id'];
        $raw->executeStatement('UPDATE wallets SET balance = balance + 5000 WHERE id = ?', [$walletId]);
        $raw->executeStatement("UPDATE wallet_transactions SET created_at = NOW() - interval '10 minutes', posted_at = NOW() - interval '9 minutes' WHERE reference = ?", [$seed]);
        $raw->executeStatement("UPDATE wallet_transactions SET created_at = NOW() - interval '8 minutes', posted_at = NOW() - interval '1 minute', balance_after = 8000 WHERE reference = ?", [$topup]);
        $raw->executeStatement("UPDATE wallet_transactions SET created_at = NOW() - interval '5 minutes', posted_at = NOW() - interval '5 minutes' WHERE reference = ?", [$consult]);

        $report = $this->reconcile();
        $mismatch = $this->only($report, 'balance_mismatch');
        $this->assertSame('5000.00', $mismatch['difference']);
        $this->assertSame($consult, $mismatch['breaks'][0]['reference'], 'where the running balance breaks');
        $repeat = $this->only($report, 'repeat_credit_suspected');
        $this->assertSame($topup, $repeat['reference'], 'the top-up is named, not the booking');
        $this->assertSame(2, $repeat['times']);
        $this->assertSame($consult, $repeat['located_at']);

        [$exit, $out] = $this->runCommand('bin/wallet-reconcile.php');
        $this->assertSame(1, $exit, $out);
        $this->assertStringContainsString($topup . ' looks credited 2 times', $out);
        $this->assertStringContainsString($topup . ' looks credited 2 times around it', $out);

        // test-only cleanup, so the other tests' "fresh schema reconciles" holds in any order
        $raw->executeStatement('DELETE FROM wallet_transactions WHERE patient_id = ?', [$patientId]);
        $raw->executeStatement('DELETE FROM wallets WHERE patient_id = ?', [$patientId]);
    }

    /** @param array<string,mixed> $report @return array<string,mixed> */
    private function only(array $report, string $kind): array
    {
        $found = $this->findingsOf($report, $kind);
        $this->assertCount(1, $found, $kind);

        return $found[0];
    }
}
