<?php

declare(strict_types=1);

namespace App\Tests\Integration\Wallet;

use App\Domain\Entity\WalletTransaction;
use App\Tests\Integration\Wallet\Support\WalletHarness;

/**
 * A top-up is credited only when Paystack's verified amount and currency EQUAL
 * what it asked for. Anything else credits nothing, is held for support
 * (audited, the patient told), stays held however often it is retried, and
 * leaves only through support's resolveHeldTopup().
 */
final class TopupAmountCheckTest extends WalletIntegrationTestCase
{
    public function testAnUnderpaymentIsHeldNotCredited(): void
    {
        [$patientId, $reference] = $this->pendingTopup('5000.00');
        [$wallets, $mail]        = $this->walletService($this->em());

        $this->assertNull($wallets->settleTopup($reference, '100', 'NGN', 'gw_1'), '₦1 paid for a ₦5,000 top-up');

        $this->assertSame(WalletTransaction::STATUS_REVIEW, $this->statusOf($reference));
        $this->assertSame('0.00', $this->balanceOf($patientId), 'nothing credited');
        $this->assertSame(0, WalletHarness::receipts($mail), 'no receipt');
        $this->assertSame(1, $this->auditCount('wallet.topup_held_for_review', $reference));
        $this->assertSame(1, $this->notificationCount($patientId, 'Top-up under review'), 'the patient is told the truth');
        $this->assertSame(0, $this->notificationCount($patientId, 'Wallet funded'));

        $meta = json_decode((string) $this->row('SELECT metadata FROM wallet_transactions WHERE reference = ?', [$reference])['metadata'], true);
        $this->assertSame('amount_mismatch', $meta['review']['reason']);
        $this->assertSame('500000', $meta['review']['expected_amount_minor']);
        $this->assertSame('100', $meta['review']['verified_amount_minor']);

        // Retries (webhook redelivery, another verify) neither credit nor re-notify.
        [$again] = $this->walletService($this->em());
        $this->assertNull($again->settleTopup($reference, '100', 'NGN'));
        $this->assertNull($again->settleTopup($reference, '500000', 'NGN'), 'a held entry is never credited by settle');
        $this->assertSame('0.00', $this->balanceOf($patientId));
        $this->assertSame(1, $this->auditCount('wallet.topup_held_for_review', $reference));
        $this->assertSame(1, $this->notificationCount($patientId, 'Top-up under review'));
    }

    public function testAnOverpaymentOrOtherCurrencyIsHeldToo(): void
    {
        [$patientId, $over] = $this->pendingTopup('100.00');
        [$wallets]          = $this->walletService($this->em());
        $this->assertNull($wallets->settleTopup($over, '1000000', 'NGN'), 'equal, not >=');
        $this->assertSame(WalletTransaction::STATUS_REVIEW, $this->statusOf($over));

        [, $usd] = $this->pendingTopup('100.00');
        $this->assertNull($wallets->settleTopup($usd, '10000', 'USD'), 'right number, wrong currency');
        $this->assertSame(WalletTransaction::STATUS_REVIEW, $this->statusOf($usd));
        $this->assertSame('0.00', $this->balanceOf($patientId));
    }

    public function testAnExactPaymentIsCreditedAndRecordsWhatWasVerified(): void
    {
        [$patientId, $reference] = $this->pendingTopup('1234.56');
        [$wallets, $mail]        = $this->walletService($this->em());

        $posted = $wallets->settleTopup($reference, '0123456', 'ngn', 'gw_42');
        $this->assertNotNull($posted);
        $this->assertSame('1234.56', $this->balanceOf($patientId));
        $this->assertSame(1, WalletHarness::receipts($mail));
        $meta = $posted->getMetadata();
        $this->assertSame('123456', $meta['verified_amount_minor']);
        $this->assertSame('NGN', $meta['verified_currency']);
        $this->assertSame('gw_42', $posted->getProviderReference());
    }

    public function testAMalformedVerifiedAmountChangesNothing(): void
    {
        [$patientId, $reference] = $this->pendingTopup('50.00');
        [$wallets]               = $this->walletService($this->em());
        foreach (['', '-5000', '50.00', '5e3', 'abc'] as $bad) {
            try {
                $wallets->settleTopup($reference, $bad, 'NGN');
                $this->fail('accepted ' . var_export($bad, true));
            } catch (\InvalidArgumentException) {
            }
        }
        $this->assertSame(WalletTransaction::STATUS_PENDING, $this->statusOf($reference));
        $this->assertSame(0, (int) $this->em()->getConnection()->fetchOne('SELECT COUNT(*) FROM wallets WHERE patient_id = ? AND balance <> 0', [$patientId]));
    }

    public function testOnlyTopupsCanBeSettled(): void
    {
        $patientId = WalletHarness::seedPatient($this->em());
        [$wallets] = $this->walletService($this->em());
        $wallets->credit($patientId, 'NGN', '10.00', WalletTransaction::TYPE_REFUND, 'refund_it_only', null, false);

        $this->expectException(\RuntimeException::class);
        $wallets->settleTopup('refund_it_only', '1000', 'NGN');
    }

    public function testSupportResolvesAHeldTopupOnce(): void
    {
        [$patientId, $reference] = $this->pendingTopup('5000.00');
        [$wallets]               = $this->walletService($this->em());
        $this->assertNull($wallets->settleTopup($reference, '300000', 'NGN', 'gw_7'));

        // Support checked Paystack: ₦3,000 really arrived — credit that.
        [$support, $mail] = $this->walletService($this->em());
        $credit           = $support->resolveHeldTopup($reference, '3000.00', 'Paystack shows ₦3,000 received', 'Support: Ada');
        $this->assertNotNull($credit);
        $this->assertSame(WalletTransaction::TYPE_ADJUSTMENT, $credit->getType());
        $this->assertSame('3000.00', $this->balanceOf($patientId));
        $this->assertSame('3000.00', $this->ledgerOf($patientId));
        $this->assertSame(WalletTransaction::STATUS_RESOLVED, $this->statusOf($reference));
        $this->assertSame(1, WalletHarness::receipts($mail));
        $this->assertSame(1, $this->auditCount('wallet.topup_review_resolved', $reference));

        // Repeating it (or a late webhook) moves nothing.
        [$again] = $this->walletService($this->em());
        $this->assertNull($again->resolveHeldTopup($reference, '3000.00', 'again', 'Support: Ada'));
        $this->assertNull($again->settleTopup($reference, '500000', 'NGN'));
        $this->assertSame('3000.00', $this->balanceOf($patientId));
    }

    public function testSupportCanCloseARefundedHeldTopupWithoutCredit(): void
    {
        [$patientId, $reference] = $this->pendingTopup('800.00');
        [$wallets]               = $this->walletService($this->em());
        $wallets->settleTopup($reference, '1', 'NGN');

        $this->assertNotNull($wallets->resolveHeldTopup($reference, null, 'Refunded on Paystack', 'Support: Ada'));
        $this->assertSame(WalletTransaction::STATUS_RESOLVED, $this->statusOf($reference));
        $this->assertSame('0.00', $this->balanceOf($patientId));
    }
}
