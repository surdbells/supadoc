<?php

declare(strict_types=1);

namespace App\Tests\Integration\Wallet;

use App\Action\Wallet\VerifyFundingAction;
use App\Domain\Entity\WalletTransaction;
use App\Domain\Repository\WalletTransactionRepository;
use App\Infrastructure\Service\PaystackService;
use App\Tests\Integration\Wallet\Support\WalletHarness;
use Monolog\Handler\TestHandler;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response;

/**
 * POST /portal/wallet/verify end to end: real Postgres, the real action and
 * services, and a LOCAL fake of Paystack's verify endpoint (php -S), so the
 * gateway calls can be scripted and counted. Each call uses a fresh
 * EntityManager — a separate request.
 */
final class VerifyFundingActionTest extends WalletIntegrationTestCase
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

    public function testCreditsOnceAndAnswersRepeatsFromTheLedger(): void
    {
        [$patientId, $reference] = $this->pendingTopup('5000.00');
        $this->paystackSays($reference, 'success', 500000);

        [$status, $body, $mail] = $this->verify($patientId, $reference);
        $this->assertSame(200, $status);
        $this->assertSame('success', $body['data']['status']);
        $this->assertSame('Wallet funded', $body['message']);
        $this->assertSame('5000.00', $body['data']['wallet']['balance']);
        $this->assertSame(1, WalletHarness::receipts($mail));

        // The redirect re-verifies, the user refreshes: same answer, nothing more.
        foreach ([1, 2] as $_) {
            [$status, $body, $mail] = $this->verify($patientId, $reference);
            $this->assertSame(200, $status);
            $this->assertSame('success', $body['data']['status']);
            $this->assertSame('This payment is already in your wallet', $body['message']);
            $this->assertSame('5000.00', $body['data']['wallet']['balance']);
            $this->assertSame(0, WalletHarness::receipts($mail), 'no second receipt');
        }
        $this->assertSame('5000.00', $this->balanceOf($patientId));
        $this->assertSame(1, $this->gatewayCalls($reference), 'a decided top-up is answered without calling Paystack again');
    }

    public function testSomeoneElsesReferenceIsNotFound(): void
    {
        [, $reference]  = $this->pendingTopup('100.00');
        $stranger       = WalletHarness::seedPatient($this->em());
        [$status]       = $this->verify($stranger, $reference);
        $this->assertSame(404, $status);
        $this->assertSame(0, $this->gatewayCalls($reference));
    }

    public function testAWrongAmountIsHeldAndThePatientToldHonestly(): void
    {
        [$patientId, $reference] = $this->pendingTopup('5000.00');
        $this->paystackSays($reference, 'success', 100);

        [$status, $body] = $this->verify($patientId, $reference);
        $this->assertSame(409, $status);
        $this->assertStringContainsString("We received your payment, but it doesn't match", $body['message']);
        $this->assertStringContainsString($reference, $body['message']);
        $this->assertSame('0.00', $this->balanceOf($patientId));
        $this->assertSame(WalletTransaction::STATUS_REVIEW, $this->statusOf($reference));

        [$status] = $this->verify($patientId, $reference);
        $this->assertSame(409, $status);
        $this->assertSame(1, $this->gatewayCalls($reference));
    }

    /**
     * Review finding (Medium): with Paystack's charges passed to the customer,
     * data.amount is the top-up PLUS the fee (requested_amount is the top-up).
     * The top-up must settle — for the top-up amount; the fee is Paystack's.
     */
    public function testAFeePassedToTheCustomerNeitherBlocksTheTopupNorIsCredited(): void
    {
        [$patientId, $reference] = $this->pendingTopup('5000.00');
        $this->paystackSays($reference, 'success', 507500, 'NGN', ['requested_amount' => 500000, 'fees' => 7500]);

        [$status, $body] = $this->verify($patientId, $reference);
        $this->assertSame(200, $status, (string) ($body['message'] ?? ''));
        $this->assertSame('Wallet funded', $body['message']);
        $this->assertSame('5000.00', $this->balanceOf($patientId), 'the ₦75 fee is not credited');
        $meta = json_decode((string) $this->row('SELECT metadata FROM wallet_transactions WHERE reference = ?', [$reference])['metadata'], true);
        $this->assertSame('500000', $meta['verified_amount_minor']);
        $this->assertSame(['gross_amount_minor' => '507500', 'fees_minor' => '7500', 'requested_amount_minor' => '500000'], $meta['gateway']);
    }

    public function testStillProcessingStaysPendingAndIsCreditedWhenConfirmed(): void
    {
        [$patientId, $reference] = $this->pendingTopup('2000.00');
        $this->paystackSays($reference, 'ongoing', 200000);

        [$status, $body] = $this->verify($patientId, $reference);
        $this->assertSame(409, $status);
        $this->assertStringContainsString('still being confirmed', $body['message']);
        $this->assertSame(WalletTransaction::STATUS_PENDING, $this->statusOf($reference));

        $this->paystackSays($reference, 'success', 200000);
        [$status] = $this->verify($patientId, $reference);
        $this->assertSame(200, $status);
        $this->assertSame('2000.00', $this->balanceOf($patientId));
    }

    public function testAFailedChargeAddsNothingButCanStillBeCreditedIfPaidLater(): void
    {
        [$patientId, $reference] = $this->pendingTopup('300.00');
        $this->paystackSays($reference, 'failed', 30000);

        [$status, $body] = $this->verify($patientId, $reference);
        $this->assertSame(402, $status);
        $this->assertStringContainsString('nothing was added to your wallet', $body['message']);
        $this->assertSame(WalletTransaction::STATUS_FAILED, $this->statusOf($reference));

        $this->paystackSays($reference, 'success', 30000);
        [$status] = $this->verify($patientId, $reference);
        $this->assertSame(200, $status);
        $this->assertSame('300.00', $this->balanceOf($patientId));
    }

    public function testAnAbandonedCheckoutIsNotMarkedFailed(): void
    {
        [$patientId, $reference] = $this->pendingTopup('300.00');
        $this->paystackSays($reference, 'abandoned', 30000);

        [$status] = $this->verify($patientId, $reference);
        $this->assertSame(402, $status);
        $this->assertSame(WalletTransaction::STATUS_PENDING, $this->statusOf($reference), 'it can still be paid; the webhook then credits it');
        $this->assertSame('0.00', $this->balanceOf($patientId));
    }

    /**
     * Review finding (Low): Paystack answered this request "failed" (an early
     * declined card) while the retry on the same checkout succeeded and the
     * webhook credited the top-up during the call. "Nothing was added to your
     * wallet" would be false — and would send the patient to pay again.
     */
    public function testANotPaidAnswerAfterAConcurrentCreditSaysTheMoneyIsInTheWallet(): void
    {
        foreach (['failed', 'abandoned', 'ongoing'] as $paystackStatus) {
            [$patientId, $reference] = $this->pendingTopup('300.00');
            $this->paystackSays($reference, $paystackStatus, 30000);
            WalletHarness::settleDuringNextVerify(self::$fake['dir'], (string) static::$schema, $reference, '30000');

            [$status, $body, $mail] = $this->verify($patientId, $reference);
            $this->assertSame(200, $status, $paystackStatus . ': ' . ($body['message'] ?? ''));
            $this->assertSame('This payment is already in your wallet', $body['message'], $paystackStatus);
            $this->assertSame('300.00', $body['data']['wallet']['balance']);
            $this->assertSame(0, WalletHarness::receipts($mail), 'the webhook sent the receipt, not this request');
            $this->assertSame(WalletTransaction::STATUS_SUCCESS, $this->statusOf($reference), 'never downgraded');
            $this->assertSame('300.00', $this->balanceOf($patientId), 'credited once');
        }
    }

    /**
     * Review finding (High): a pre-fix row the late-failure race left `failed`
     * after crediting it. Re-opening the callback URL must not credit it again
     * — and the patient is told the truth: it is in their wallet.
     */
    public function testARowTheOldRaceLeftFailedAfterCreditingIsNotCreditedAgain(): void
    {
        [$patientId, $reference] = $this->pendingTopup('5000.00');
        $this->paystackSays($reference, 'success', 500000);
        [$status] = $this->verify($patientId, $reference);
        $this->assertSame(200, $status);
        $this->em()->getConnection()->executeStatement("UPDATE wallet_transactions SET status = 'failed' WHERE reference = ?", [$reference]);

        [$status, $body, $mail] = $this->verify($patientId, $reference);
        $this->assertSame(200, $status);
        $this->assertSame('This payment is already in your wallet', $body['message']);
        $this->assertSame('Top-up', $body['data']['transaction']['label'], 'the history does not say "not completed"');
        $this->assertSame(0, WalletHarness::receipts($mail));
        $this->assertSame('5000.00', $this->balanceOf($patientId), 'not credited a second time');
        $this->assertSame(1, $this->gatewayCalls($reference), 'answered from the ledger');
    }

    /** @param array<string,mixed> $extra */
    private function paystackSays(string $reference, string $status, int $amountMinor, string $currency = 'NGN', array $extra = []): void
    {
        WalletHarness::paystackSays(self::$fake['dir'], $reference, $status, $amountMinor, $currency, $extra);
    }

    private function gatewayCalls(string $reference): int
    {
        return WalletHarness::gatewayCalls(self::$fake['dir'], $reference);
    }

    /** @return array{0:int, 1:array<string,mixed>, 2:TestHandler} one request, with its own EntityManager */
    private function verify(string $customerId, string $reference): array
    {
        $em              = $this->em();
        [$wallets, $mail] = $this->walletService($em);
        $action          = new VerifyFundingAction(
            $wallets,
            new WalletTransactionRepository($em),
            new PaystackService('sk_test_local_fake', 'pk_test_local_fake', self::$fake['url']),
        );
        $request = (new ServerRequestFactory())->createServerRequest('POST', '/api/portal/wallet/verify')
            ->withAttribute('customer_id', $customerId)
            ->withParsedBody(['reference' => $reference]);

        $response = $action($request, new Response());
        $this->assertSame('no-store', $response->getHeaderLine('Cache-Control'));

        return [$response->getStatusCode(), (array) json_decode((string) $response->getBody(), true), $mail];
    }
}
