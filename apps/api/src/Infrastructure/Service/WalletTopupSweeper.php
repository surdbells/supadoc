<?php

declare(strict_types=1);

namespace App\Infrastructure\Service;

use App\Domain\Entity\WalletTransaction;
use App\Domain\Repository\WalletTransactionRepository;
use Doctrine\ORM\EntityManagerInterface;

/**
 * Re-checks wallet top-ups that never posted (pending / failed) with Paystack
 * and credits the ones Paystack says were paid — through
 * {@see WalletService::settleTopup()}, so at most once, only for the exact
 * amount (anything else is held for support), receipt + notice from the call
 * that credited. Run by bin/wallet-topup-sweep.php (a dry run unless told to
 * apply).
 *
 * Why it exists: Paystack delivers a webhook and gives up after its retries.
 * The pre-fix verify marked every not-yet-successful payment `failed` and the
 * pre-fix webhook only settled pending rows, so a payment that completed later
 * was never credited; and a webhook refused for a wrong signature leaves a paid
 * top-up pending until the patient happens to verify it again. This is the
 * sweep for both.
 *
 * It never touches a row that already moved money (see
 * WalletTransaction::wasPosted()), a held or resolved one, or anything that is
 * not a top-up. A dry run writes nothing at all; applying writes only what
 * settleTopup writes. Nothing is ever marked failed here.
 */
final class WalletTopupSweeper
{
    public function __construct(
        private readonly EntityManagerInterface $em,
        private readonly WalletService $wallets,
        private readonly WalletTransactionRepository $txns,
        private readonly PaystackService $paystack,
    ) {
    }

    /**
     * @param bool $apply         false = dry run (asks Paystack, changes nothing)
     * @param int  $minAgeMinutes leave younger checkouts alone (the patient may still be paying)
     * @param int  $maxAgeDays    only top-ups started within this many days; 0 = all, however old
     * @param int  $limit         at most this many (newest first); 0 = all
     * @param int  $pauseMs       pause between Paystack calls
     * @return array{
     *   apply: bool,
     *   candidates: int,
     *   checked: int,
     *   results: list<array{reference:string, status:string, amount:string, currency:string, created_at:string, outcome:string, detail:string}>,
     *   stopped: ?string,
     * }
     */
    public function sweep(bool $apply, int $minAgeMinutes = 15, int $maxAgeDays = 30, int $limit = 1000, int $pauseMs = 150): array
    {
        [$where, $params] = $this->candidateFilter($minAgeMinutes, $maxAgeDays);
        $table            = $this->em->getClassMetadata(WalletTransaction::class)->getTableName();
        $conn             = $this->em->getConnection();
        $candidates       = (int) $conn->fetchOne(sprintf('SELECT COUNT(*) FROM %s WHERE %s', $table, $where), $params);
        $rows             = $conn->fetchAllAssociative(
            sprintf(
                "SELECT reference, status, amount::text AS amount, currency, to_char(created_at, 'YYYY-MM-DD HH24:MI:SS') AS created_at
                   FROM %s WHERE %s ORDER BY created_at DESC, reference%s",
                $table,
                $where,
                $limit > 0 ? ' LIMIT ' . $limit : '',
            ),
            $params,
        );

        $results = [];
        $stopped = null;
        foreach ($rows as $i => $row) {
            if ($i > 0 && $pauseMs > 0) {
                usleep($pauseMs * 1000);
            }
            $base = [
                'reference'  => (string) $row['reference'],
                'status'     => (string) $row['status'],
                'amount'     => (string) $row['amount'],
                'currency'   => (string) $row['currency'],
                'created_at' => (string) $row['created_at'],
            ];
            try {
                [$outcome, $detail] = $this->check($base['reference'], $apply);
            } catch (\Throwable $e) {
                [$outcome, $detail] = ['error', $e->getMessage()];
                if (!$this->em->isOpen()) {
                    $results[] = $base + ['outcome' => $outcome, 'detail' => $detail];
                    $stopped   = 'stopped after a database error: ' . $e->getMessage();
                    break;
                }
            }
            $results[] = $base + ['outcome' => $outcome, 'detail' => $detail];
            $this->em->clear(); // nothing pending; keeps a long sweep's memory flat
        }

        return [
            'apply'      => $apply,
            'candidates' => $candidates,
            'checked'    => count($results),
            'results'    => $results,
            'stopped'    => $stopped,
        ];
    }

    /**
     * One top-up: ask Paystack, then (when applying) settle a paid one.
     *
     * @return array{0: string, 1: string} outcome and a human-readable detail
     */
    private function check(string $reference, bool $apply): array
    {
        try {
            $verified = $this->paystack->verify($reference);
        } catch (\RuntimeException $e) {
            // Paystack has no transaction under this reference (its initialize
            // failed, so the patient never got to pay): a definite answer —
            // nothing was paid — not an outage to report every night.
            if (PaystackCardGateway::isNotFound($e)) {
                return ['not_paid', 'Paystack: no transaction under this reference'];
            }

            return ['gateway_error', $e->getMessage()];
        }

        $paystackStatus = (string) $verified['status'];
        switch (WalletService::gatewayOutcome($paystackStatus)) {
            case 'not_paid':
                return ['not_paid', 'Paystack: ' . $paystackStatus];
            case 'processing':
                return ['still_processing', 'Paystack: ' . $paystackStatus];
        }

        $amountMinor = (string) $verified['amount_minor'];
        $currency    = (string) $verified['currency'];
        $paid        = sprintf('Paystack: success, %s minor units of %s', $amountMinor, $currency !== '' ? $currency : '?');

        if (!$apply) {
            $entry = $this->txns->byReferenceFresh($reference);
            if ($entry === null || !$entry->isSettleable()) {
                return ['already_settled', $paid . ($entry !== null ? '; entry is now ' . $entry->getStatus() : '')];
            }
            try {
                $mismatch = WalletService::topupMismatch($entry, $amountMinor, $currency);
            } catch (\InvalidArgumentException $e) {
                return ['gateway_error', 'unusable Paystack amount: ' . $e->getMessage()];
            }

            return $mismatch === null
                ? ['would_credit', $paid]
                : ['would_hold_for_review', $paid . ' (' . $mismatch['reason'] . ')'];
        }

        try {
            $posted = $this->wallets->settleTopup($reference, $amountMinor, $currency, $verified['gateway_reference'] ?? null, [
                'gross_amount_minor'     => $verified['gross_amount_minor'] ?? null,
                'fees_minor'             => $verified['fees_minor'] ?? null,
                'requested_amount_minor' => $verified['requested_amount_minor'] ?? null,
            ]);
        } catch (\InvalidArgumentException $e) {
            return ['gateway_error', 'unusable Paystack amount: ' . $e->getMessage()];
        }
        if ($posted !== null) {
            return ['credited', $paid . '; balance after ' . (string) $posted->getBalanceAfter()];
        }

        $now = $this->txns->byReferenceFresh($reference);

        return match (true) {
            $now?->needsReview() === true => ['held_for_review', $paid . '; amount/currency differs — held for support, nothing credited'],
            $now?->isSuccess() === true   => ['already_settled', $paid . '; credited by another request meanwhile'],
            default                       => ['not_credited', $paid . '; entry is ' . ($now?->getStatus() ?? 'gone')],
        };
    }

    /**
     * Top-ups that never moved money and are still open, in the age window.
     *
     * @return array{0: string, 1: list<string>}
     */
    private function candidateFilter(int $minAgeMinutes, int $maxAgeDays): array
    {
        $where  = "type = 'topup' AND direction = 'credit' AND status IN ('pending', 'failed')
                   AND posted_at IS NULL AND balance_after IS NULL AND created_at < ?";
        $params = [(new \DateTimeImmutable(sprintf('-%d minutes', max(0, $minAgeMinutes))))->format('Y-m-d H:i:s')];
        if ($maxAgeDays > 0) {
            $where   .= ' AND created_at >= ?';
            $params[] = (new \DateTimeImmutable(sprintf('-%d days', $maxAgeDays)))->format('Y-m-d H:i:s');
        }

        return [$where, $params];
    }
}
