<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Domain\Entity\WalletTransaction;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * The ledger entry's own state machine (audit M2): an entry's money moves at
 * most once, so posting is only possible from pending/failed, a posted entry
 * is never failed, and a held entry is never posted.
 */
final class WalletTransactionStateTest extends TestCase
{
    private function topup(string $status = WalletTransaction::STATUS_PENDING): WalletTransaction
    {
        return new WalletTransaction('w-1', 'p-1', WalletTransaction::TYPE_TOPUP, WalletTransaction::DIR_CREDIT, '5000.00', 'ngn', 'vmw_ref', $status);
    }

    public function testAPendingOrFailedTopupPostsOnce(): void
    {
        foreach ([WalletTransaction::STATUS_PENDING, WalletTransaction::STATUS_FAILED] as $from) {
            $txn = $this->topup($from);
            $this->assertTrue($txn->isSettleable());
            $txn->markPosted('5000.00', 'paystack', 'gw_1');
            $this->assertTrue($txn->isSuccess());
            $this->assertSame('5000.00', $txn->getBalanceAfter());
            $this->assertNotNull($txn->getPostedAt());
            $this->assertSame('gw_1', $txn->getProviderReference());
            $this->assertFalse($txn->isSettleable());

            try {
                $txn->markPosted('10000.00');
                $this->fail('posting twice must be impossible');
            } catch (\LogicException $e) {
                $this->assertStringContainsString('cannot move from success to success', $e->getMessage());
            }
            $this->assertSame('5000.00', $txn->getBalanceAfter(), 'the refused posting changed nothing');
        }
    }

    /** @return iterable<string, array{string}> */
    public static function notPostable(): iterable
    {
        yield 'success'  => [WalletTransaction::STATUS_SUCCESS];
        yield 'review'   => [WalletTransaction::STATUS_REVIEW];
        yield 'resolved' => [WalletTransaction::STATUS_RESOLVED];
        yield 'reversed' => [WalletTransaction::STATUS_REVERSED];
    }

    #[DataProvider('notPostable')]
    public function testOnlyPendingOrFailedCanBePostedOrHeld(string $status): void
    {
        $txn = $this->topup($status);
        $this->assertFalse($txn->isSettleable());
        try {
            $txn->markPosted('1.00');
            $this->fail('posted from ' . $status);
        } catch (\LogicException) {
        }
        try {
            $txn->holdForReview(['reason' => 'amount_mismatch']);
            $this->fail('held from ' . $status);
        } catch (\LogicException) {
        }
        $this->assertSame($status, $txn->getStatus());
    }

    public function testOnlyAPendingTopupFails(): void
    {
        $txn = $this->topup();
        $txn->markFailed();
        $this->assertSame(WalletTransaction::STATUS_FAILED, $txn->getStatus());

        foreach ([WalletTransaction::STATUS_SUCCESS, WalletTransaction::STATUS_FAILED, WalletTransaction::STATUS_REVIEW] as $status) {
            $other = $this->topup($status);
            try {
                $other->markFailed();
                $this->fail('failed from ' . $status);
            } catch (\LogicException) {
                $this->assertSame($status, $other->getStatus(), 'a posted top-up is never downgraded');
            }
        }
    }

    public function testAHeldTopupKeepsWhatWasVerifiedAndIsOnlyResolvedBySupport(): void
    {
        $txn = $this->topup();
        $txn->setMetadata(['kept' => true]);
        $txn->holdForReview(['reason' => 'amount_mismatch', 'verified_amount_minor' => '100'], 'gw_9');
        $this->assertTrue($txn->needsReview());
        $this->assertNull($txn->getBalanceAfter(), 'nothing posted');
        $this->assertSame('gw_9', $txn->getProviderReference());
        $this->assertSame(['kept' => true, 'review' => ['reason' => 'amount_mismatch', 'verified_amount_minor' => '100']], $txn->getMetadata());

        $txn->markResolved(['note' => 'refunded on Paystack']);
        $this->assertSame(WalletTransaction::STATUS_RESOLVED, $txn->getStatus());
        $this->assertSame('refunded on Paystack', $txn->getMetadata()['resolution']['note']);

        $this->expectException(\LogicException::class);
        $txn->markResolved([]);
    }

    public function testTheHistoryLabelNeverShowsUnpostedMoneyAsAdded(): void
    {
        $txn = $this->topup();
        $this->assertSame('Top-up · pending', $txn->label());
        $txn->holdForReview(['reason' => 'amount_mismatch']);
        $txn->initTimestamps(); // as on persist
        $this->assertSame('Top-up · under review', $txn->toArray()['label'], 'what the history API sends');
        $txn->markResolved([]);
        $this->assertSame('Top-up · resolved by support', $txn->label());

        $failed = $this->topup();
        $failed->markFailed();
        $this->assertSame('Top-up · not completed', $failed->label());

        $posted = $this->topup();
        $posted->markPosted('5000.00');
        $this->assertSame('Top-up', $posted->label(), 'unchanged for posted entries (and their receipts)');
    }

    /** What the pre-fix late-failure race left: credited, then only `status` rewritten to failed. */
    private function postedThenMarkedFailed(): WalletTransaction
    {
        $txn = $this->topup();
        $txn->markPosted('5000.00', 'paystack', 'gw_1');
        (new \ReflectionProperty(WalletTransaction::class, 'status'))->setValue($txn, WalletTransaction::STATUS_FAILED);

        return $txn;
    }

    public function testARowThatMovedMoneyIsNeverSettleableWhateverItsStatus(): void
    {
        $txn = $this->postedThenMarkedFailed();
        $this->assertSame(WalletTransaction::STATUS_FAILED, $txn->getStatus());
        $this->assertTrue($txn->wasPosted());
        $this->assertTrue($txn->isPostedButNotSuccess());
        $this->assertFalse($txn->isSettleable(), 'failed, but its money already moved');

        foreach (['markPosted' => fn () => $txn->markPosted('10000.00'), 'holdForReview' => fn () => $txn->holdForReview([]), 'markFailed' => fn () => $txn->markFailed()] as $what => $call) {
            try {
                $call();
                $this->fail($what . ' accepted a row that already posted');
            } catch (\LogicException $e) {
                $this->addToAssertionCount(1);
            }
        }
        $this->assertSame('5000.00', $txn->getBalanceAfter(), 'nothing changed');

        // Only a pending row with a stray balance_after counts as posted too.
        $partial = $this->topup();
        (new \ReflectionProperty(WalletTransaction::class, 'balanceAfter'))->setValue($partial, '1.00');
        $this->assertFalse($partial->isSettleable());
        $this->expectException(\LogicException::class);
        $partial->markFailed();
    }

    public function testSupportRestoresSuchARowWithoutMovingMoney(): void
    {
        $txn    = $this->postedThenMarkedFailed();
        $posted = $txn->getPostedAt();
        $this->assertSame('Top-up', $txn->label(), 'the history must not say "not completed" for money that was added');

        $txn->restorePosted(['note' => 'old race']);
        $this->assertTrue($txn->isSuccess());
        $this->assertSame('5000.00', $txn->getBalanceAfter());
        $this->assertSame($posted, $txn->getPostedAt(), 'posting untouched');
        $this->assertSame('old race', $txn->getMetadata()['restored']['note']);
        $this->assertFalse($txn->isPostedButNotSuccess());

        foreach ([$this->topup(), $this->topup(WalletTransaction::STATUS_FAILED), $txn] as $notRestorable) {
            try {
                $notRestorable->restorePosted([]);
                $this->fail('restored a row that never posted, or is already success');
            } catch (\LogicException) {
                $this->addToAssertionCount(1);
            }
        }
    }

    public function testOnlyACreditTopupIsATopup(): void
    {
        $this->assertTrue($this->topup()->isTopup());
        $this->assertFalse((new WalletTransaction('w', 'p', WalletTransaction::TYPE_REFUND, WalletTransaction::DIR_CREDIT, '1.00', 'NGN', 'r'))->isTopup());
        $this->assertFalse((new WalletTransaction('w', 'p', WalletTransaction::TYPE_TOPUP, WalletTransaction::DIR_DEBIT, '1.00', 'NGN', 'r'))->isTopup());
    }
}
