<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Infrastructure\Service\WalletReconciler;
use PHPUnit\Framework\TestCase;

/**
 * WalletReconciler::chainBreaks() — where a wallet's running balance stops
 * adding up, and which reference to blame. (The full read-only report against
 * Postgres: tests/Integration/Wallet/WalletReconcilerTest.)
 */
final class WalletReconcilerChainTest extends TestCase
{
    /** @return array<string,mixed> */
    private static function row(string $ref, string $type, string $dir, string $amount, ?string $after, string $created, ?string $posted = null, string $status = 'success'): array
    {
        return [
            'id'            => 'id-' . $ref,
            'reference'     => $ref,
            'type'          => $type,
            'direction'     => $dir,
            'status'        => $status,
            'amount'        => $amount,
            'balance_after' => $after,
            'created_at'    => '2026-10-01 10:00:' . $created,
            'posted_at'     => $posted !== null ? '2026-10-01 10:00:' . $posted : null,
        ];
    }

    public function testAConsistentChainHasNoBreaks(): void
    {
        $this->assertSame([], WalletReconciler::chainBreaks([
            self::row('seed', 'refund', 'credit', '1000.00', '1000.00', '00', '00'),
            self::row('vmw_a', 'topup', 'credit', '5000.00', '6000.00', '01', '02'),
            self::row('appt_1', 'consultation', 'debit', '3000.00', '3000.00', '03', '03'),
        ]));
    }

    public function testATopupWhoseOwnJumpIsAMultipleIsNamed(): void
    {
        // Credited twice back to back: one row, balance_after doubled.
        $breaks = WalletReconciler::chainBreaks([
            self::row('vmw_x', 'topup', 'credit', '5000.00', '10000.00', '00', '05'),
        ]);
        $this->assertCount(1, $breaks);
        $this->assertSame('vmw_x', $breaks[0]['repeat_reference']);
        $this->assertSame(2, $breaks[0]['repeat_times']);
    }

    /**
     * Concurrency review finding: verify credits vmw_x, the app books at once
     * (consultation debit), then the stale webhook credits vmw_x AGAIN — which
     * overwrote vmw_x's balance_after/posted_at. vmw_x now chains cleanly and
     * the +5000 shows on the consultation. The top-up must still be named.
     */
    public function testATopupCreditedAroundAnotherPostingIsNamedNotTheEntryInBetween(): void
    {
        $breaks = WalletReconciler::chainBreaks([
            self::row('seed', 'refund', 'credit', '1000.00', '1000.00', '00', '00'),
            self::row('consult_1', 'consultation', 'debit', '3000.00', '3000.00', '02', '03'),
            self::row('vmw_x', 'topup', 'credit', '5000.00', '8000.00', '01', '04'), // started 01, credited 02 + (again) 04
        ]);

        $this->assertCount(1, $breaks);
        $this->assertSame('consult_1', $breaks[0]['reference'], 'where the chain breaks');
        $this->assertSame('5000.00', $breaks[0]['unexplained']);
        $this->assertSame('vmw_x', $breaks[0]['repeat_reference'], 'who is to blame');
        $this->assertSame(2, $breaks[0]['repeat_times']);
        $this->assertSame('5000.00', $breaks[0]['repeat_amount']);
    }

    public function testATopupStartedAfterTheBreakOrDoneBeforeItIsNotASuspect(): void
    {
        $breaks = WalletReconciler::chainBreaks([
            self::row('vmw_old', 'topup', 'credit', '5000.00', '5000.00', '00', '01'), // done before the break
            self::row('adj', 'adjustment', 'credit', '100.00', '10100.00', '02', '02'), // +5000 unexplained here
            self::row('vmw_new', 'topup', 'credit', '5000.00', '15100.00', '03', '04'), // started after it
        ]);
        $this->assertCount(1, $breaks);
        $this->assertSame('adj', $breaks[0]['reference']);
        $this->assertNull($breaks[0]['repeat_times'], 'no top-up was in flight around it');
        $this->assertSame([], $breaks[0]['suspects']);
    }

    public function testSeveralPossibleCulpritsAreListedNotAccused(): void
    {
        $breaks = WalletReconciler::chainBreaks([
            self::row('consult_1', 'consultation', 'debit', '1000.00', '4000.00', '02', '02'), // -1000 from 0, recorded +4000: 5000 unexplained
            self::row('vmw_a', 'topup', 'credit', '5000.00', '9000.00', '01', '03'),
            self::row('vmw_b', 'topup', 'credit', '5000.00', '14000.00', '01', '04'),
        ]);
        $this->assertSame('consult_1', $breaks[0]['reference']);
        $this->assertNull($breaks[0]['repeat_times']);
        $this->assertSame(['vmw_a', 'vmw_b'], $breaks[0]['suspects']);
    }

    /**
     * Money review finding (High): a pre-fix row left `failed` after it was
     * credited is part of the chain (it moved the balance). Leaving it out
     * blamed the NEXT legitimate top-up as "credited 2 times" — and finance
     * would have clawed back money the patient really paid.
     */
    public function testARowLeftFailedAfterPostingKeepsTheChainWhole(): void
    {
        $entries = [
            self::row('vmw_old', 'topup', 'credit', '5000.00', '5000.00', '00', '01', 'failed'),
            self::row('vmw_legit', 'topup', 'credit', '5000.00', '10000.00', '05', '06'),
        ];
        $this->assertSame([], WalletReconciler::chainBreaks($entries));

        // Without it (what the old reconciler walked), the legitimate one is accused:
        $breaks = WalletReconciler::chainBreaks([$entries[1]]);
        $this->assertSame('vmw_legit', $breaks[0]['repeat_reference']);
    }
}
