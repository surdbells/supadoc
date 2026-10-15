<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Action\Wallet\VerifyFundingAction;
use App\Domain\Entity\WalletTransaction;
use App\Domain\Repository\WalletTransactionRepository;
use App\Infrastructure\Persistence\DoctrineEntityManagerFactory;
use App\Infrastructure\Service\PaystackService;
use App\Infrastructure\Service\WalletService;
use Doctrine\ORM\Query;
use PHPUnit\Framework\TestCase;

/**
 * The pure rules behind settling a top-up: the verified amount must EQUAL the
 * expected one, gateway amounts are digits only, input amounts can't crash
 * bcmath, and which Paystack statuses count as paid.
 */
final class WalletTopupRulesTest extends TestCase
{
    private function topup(string $amount = '5000.00', string $currency = 'NGN'): WalletTransaction
    {
        return new WalletTransaction('w-1', 'p-1', WalletTransaction::TYPE_TOPUP, WalletTransaction::DIR_CREDIT, $amount, $currency, 'vmw_ref');
    }

    public function testOnlyTheExactAmountAndCurrencySettle(): void
    {
        $this->assertNull(WalletService::topupMismatch($this->topup(), '500000', 'NGN'));
        $this->assertNull(WalletService::topupMismatch($this->topup(), '0500000', ' ngn '), 'leading zeros / case / spaces are formatting, not value');
        $this->assertNull(WalletService::topupMismatch($this->topup('1234.56'), '123456', 'NGN'));

        $less = WalletService::topupMismatch($this->topup(), '100', 'NGN');
        $this->assertSame('amount_mismatch', $less['reason'] ?? null, 'an underpayment is not credited');
        $this->assertSame('500000', $less['expected_amount_minor']);
        $this->assertSame('100', $less['verified_amount_minor']);

        $this->assertSame('amount_mismatch', WalletService::topupMismatch($this->topup(), '500001', 'NGN')['reason'] ?? null, 'equal, not >=');
        $this->assertSame('currency_mismatch', WalletService::topupMismatch($this->topup(), '500000', 'USD')['reason'] ?? null);
        $this->assertSame('currency_mismatch', WalletService::topupMismatch($this->topup(), '500000', '')['reason'] ?? null, 'no currency is not NGN');
        $this->assertSame('amount_and_currency_mismatch', WalletService::topupMismatch($this->topup(), '1', 'GHS')['reason'] ?? null);
    }

    public function testGatewayAmountsAreDigitsOnly(): void
    {
        $this->assertSame('500000', WalletService::parseMinor(' 500000 '));
        $this->assertSame('0', WalletService::parseMinor('000'));
        foreach (['', '-500', '5000.00', '5e5', '0x10', 'abc', '1 000', str_repeat('9', 19)] as $bad) {
            try {
                WalletService::parseMinor($bad);
                $this->fail('accepted ' . var_export($bad, true));
            } catch (\InvalidArgumentException) {
                $this->addToAssertionCount(1);
            }
        }
        $this->assertSame('123456', WalletService::minorUnits('1234.56'));
        $this->assertSame('10', WalletService::minorUnits('0.10'));
    }

    public function testInputAmountsAreValidatedNotCrashed(): void
    {
        $wallets = (new \ReflectionClass(WalletService::class))->newInstanceWithoutConstructor();
        $this->assertSame('5.00', $wallets->normalise('5'));
        $this->assertSame('0.50', $wallets->normalise('.5'));
        $this->assertSame('10.99', $wallets->normalise(' 10.999 '));
        $this->assertSame(500000, $wallets->toMinor('5000'));

        foreach (['1e3' => 'Invalid amount', 'abc' => 'Invalid amount', '' => 'Invalid amount', '0' => 'greater than zero', '-5' => 'greater than zero', '0.001' => 'greater than zero', '1000000000000' => 'too large'] as $input => $message) {
            try {
                $wallets->normalise((string) $input);
                $this->fail('accepted ' . var_export($input, true));
            } catch (\InvalidArgumentException $e) {
                $this->assertStringContainsString($message, $e->getMessage(), (string) $input); // a 422, never a bcmath ValueError (500)
            }
        }
    }

    public function testOnlyPaystackSuccessCountsAsPaid(): void
    {
        $this->assertSame('paid', VerifyFundingAction::gatewayOutcome('success'));
        $this->assertSame('paid', VerifyFundingAction::gatewayOutcome(' SUCCESS '));
        foreach (['failed', 'abandoned', 'reversed'] as $status) {
            $this->assertSame('not_paid', VerifyFundingAction::gatewayOutcome($status), $status);
        }
        foreach (['ongoing', 'pending', 'processing', 'queued', '', 'something-new'] as $status) {
            $this->assertSame('processing', VerifyFundingAction::gatewayOutcome($status), 'not final, never paid: ' . $status);
            $this->assertSame('processing', WalletService::gatewayOutcome($status), 'the sweep uses the same rule');
        }
    }

    /**
     * Review finding (Medium): with "pass charges to customer" on the Paystack
     * account, data.amount = what we asked for + Paystack's fee. The verified
     * amount is what was paid TO US (requested_amount), so an exact top-up
     * settles and the fee is never credited; never more than was charged.
     */
    public function testTheVerifiedAmountIsWhatWasPaidToUsNotThePaystackFee(): void
    {
        // Customer bears the fee: ₦5,000 asked, ₦5,075 charged.
        $feeOnTop = ['amount' => 507500, 'requested_amount' => 500000, 'fees' => 7500];
        $this->assertSame(500000, PaystackService::paidAmountMinor($feeOnTop));
        $this->assertNull(WalletService::topupMismatch($this->topup(), (string) PaystackService::paidAmountMinor($feeOnTop), 'NGN'), 'settles — the fee is not a mismatch');

        // Merchant bears the fee: both equal.
        $this->assertSame(500000, PaystackService::paidAmountMinor(['amount' => 500000, 'requested_amount' => 500000, 'fees' => 7500]));
        // No requested_amount in the answer: the charged amount, as before.
        $this->assertSame(500000, PaystackService::paidAmountMinor(['amount' => 500000]));
        $this->assertSame(500000, PaystackService::paidAmountMinor(['amount' => '500000', 'requested_amount' => null]));
        // Charged LESS than requested: what was charged (so it never settles as the full amount).
        $this->assertSame(100, PaystackService::paidAmountMinor(['amount' => 100, 'requested_amount' => 500000]));
        $this->assertSame('amount_mismatch', WalletService::topupMismatch($this->topup(), '100', 'NGN')['reason'] ?? null);
        // Junk or missing figures never become money.
        $this->assertSame(0, PaystackService::paidAmountMinor([]));
        $this->assertSame(0, PaystackService::paidAmountMinor(['amount' => -500000, 'requested_amount' => 500000]));
        $this->assertSame(500000, PaystackService::paidAmountMinor(['amount' => 500000, 'requested_amount' => 'abc']));
        $this->assertSame(500000, PaystackService::paidAmountMinor(['amount' => 500000, 'requested_amount' => 0]));
    }

    public function testATopupCannotBeCreditedByHand(): void
    {
        $wallets = (new \ReflectionClass(WalletService::class))->newInstanceWithoutConstructor();

        $this->expectException(\InvalidArgumentException::class);
        $this->expectExceptionMessage('settleTopup');
        $wallets->credit('p-1', 'NGN', '5000.00', WalletTransaction::TYPE_TOPUP, 'makegood_vmw_x');
    }

    public function testTheFreshLookupOverwritesStaleCopiesAndCompiles(): void
    {
        $_ENV['DB_SERVER_VERSION'] = '16';
        DoctrineEntityManagerFactory::reset();
        $query = (new WalletTransactionRepository(DoctrineEntityManagerFactory::create()))->byReferenceFreshQuery('vmw_x');
        DoctrineEntityManagerFactory::reset();

        $this->assertTrue($query->getHint(Query::HINT_REFRESH), 're-reads rather than trusting the identity map');
        $this->assertStringContainsStringIgnoringCase('wallet_transactions', $query->getSQL());
        $this->assertStringContainsStringIgnoringCase('reference = ?', $query->getSQL());
    }
}
