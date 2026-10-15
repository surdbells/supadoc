<?php

declare(strict_types=1);

namespace App\Tests\Integration\Wallet;

use App\Domain\Entity\WalletTransaction;
use App\Domain\Exception\LedgerReferenceConflictException;
use App\Tests\Integration\Wallet\Support\WalletHarness;

/**
 * Money review finding (Low): a ledger reference is an idempotency key. A
 * retry with the same terms answers with the original posting; the same key
 * with DIFFERENT terms (a second make-good under a per-wallet key) used to
 * return the old entry silently — support believed the patient was credited.
 * It now refuses loudly and posts nothing.
 */
final class LedgerReferenceTest extends WalletIntegrationTestCase
{
    public function testARetryAnswersWithTheOriginalAndADifferentPostingIsRefused(): void
    {
        $patientId = WalletHarness::seedPatient($this->em());
        $em        = $this->em();
        [$wallets, $mail] = $this->walletService($em);
        $key       = 'makegood_it_' . bin2hex(random_bytes(4));

        $first = $wallets->credit($patientId, 'NGN', '1000.00', WalletTransaction::TYPE_ADJUSTMENT, $key, 'Make-good');
        $again = $wallets->credit($patientId, 'NGN', '1000.00', WalletTransaction::TYPE_ADJUSTMENT, $key, 'Make-good');
        $this->assertSame($first->getId(), $again->getId(), 'a retry is idempotent');
        $this->assertSame(1, WalletHarness::receipts($mail), 'one receipt');

        foreach ([['credit', '2500.00'], ['debit', '1000.00']] as [$direction, $amount]) {
            try {
                $direction === 'credit'
                    ? $wallets->credit($patientId, 'NGN', $amount, WalletTransaction::TYPE_ADJUSTMENT, $key, 'A later make-good')
                    : $wallets->debit($patientId, 'NGN', $amount, WalletTransaction::TYPE_ADJUSTMENT, $key, 'Clawback');
                $this->fail('a different posting under an used key was accepted');
            } catch (LedgerReferenceConflictException $e) {
                $this->assertStringContainsString('nothing was posted', $e->getMessage());
            }
        }
        $this->assertSame('1000.00', $this->balanceOf($patientId));
        $this->assertSame(1, (int) $this->em()->getConnection()->fetchOne('SELECT COUNT(*) FROM wallet_transactions WHERE reference = ?', [$key]));

        // The request's EntityManager is still usable: a correctly keyed make-good posts.
        $this->assertTrue($em->isOpen());
        $wallets->credit($patientId, 'NGN', '2500.00', WalletTransaction::TYPE_ADJUSTMENT, $key . '_20261015', 'A later make-good');
        $this->assertSame('3500.00', $this->balanceOf($patientId));
    }

    public function testATopupCannotBeCreditedByHand(): void
    {
        $patientId = WalletHarness::seedPatient($this->em());
        [$wallets] = $this->walletService($this->em());

        $this->expectException(\InvalidArgumentException::class);
        $wallets->credit($patientId, 'NGN', '1000.00', WalletTransaction::TYPE_TOPUP, 'vmw_by_hand');
    }
}
