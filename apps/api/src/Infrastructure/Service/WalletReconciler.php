<?php

declare(strict_types=1);

namespace App\Infrastructure\Service;

use App\Domain\Entity\WalletTransaction;
use Doctrine\DBAL\Connection;

/**
 * Read-only wallet reconciliation (run by bin/wallet-reconcile.php).
 *
 * Everything runs inside one REPEATABLE READ, READ ONLY database transaction
 * (one consistent snapshot; the database itself refuses any write) that is
 * rolled back at the end — this class never changes data.
 *
 * Findings (any one makes the command exit non-zero):
 *  - balance_mismatch: wallets.balance ≠ the signed sum of the wallet's
 *    successful ledger entries, with the running-balance breaks that locate the
 *    cause — walked over every entry that MOVED money (success, plus pre-fix rows
 *    left pending/failed after posting), so a break is never blamed on a later,
 *    legitimate entry. A top-up whose recorded balance jumped by a whole multiple
 *    of its amount is reported as credited N times; so is one credited around
 *    another entry (the jump then shows on that entry — see chainBreaks());
 *  - repeat_credit_suspected: references credited more than once (from those breaks);
 *  - posted_entry_not_success: an entry that moved the balance (posted_at /
 *    balance_after set) but is not marked success — what the pre-fix
 *    late-failure race left behind; its money IS in the wallet;
 *  - duplicate_provider_credit: one gateway transaction id credited by several entries;
 *  - ledger_anomaly: entries with no wallet, a currency/patient that differs from
 *    their wallet's, an unknown direction/status, a non-positive amount, or a
 *    posted entry without its balance/time;
 *  - topup_held_for_review: paid with a different amount/currency — not credited,
 *    waiting for support;
 *  - topup_amount_differs: a credited top-up whose recorded verified amount/currency
 *    differs from what it expected (must never happen since the fix).
 * Info (does not affect the exit code): top-ups that never posted and are still
 * pending/failed after `$staleHours` (bin/wallet-topup-sweep.php re-checks them
 * with Paystack), and how many credited top-ups predate amount verification.
 */
final class WalletReconciler
{
    private const SCALE = 2;

    /** SQL: the entry moved the balance (every success entry; a pre-fix row may be left pending/failed). */
    private const MOVED_MONEY = "(status = 'success' OR posted_at IS NOT NULL OR balance_after IS NOT NULL)";

    /** SQL: the entry moved the balance but is not marked success. */
    private const POSTED_NOT_SUCCESS = "(status <> 'success' AND (posted_at IS NOT NULL OR balance_after IS NOT NULL))";

    private const KNOWN_STATUSES = [
        WalletTransaction::STATUS_PENDING,
        WalletTransaction::STATUS_SUCCESS,
        WalletTransaction::STATUS_FAILED,
        WalletTransaction::STATUS_REVERSED,
        WalletTransaction::STATUS_REVIEW,
        WalletTransaction::STATUS_RESOLVED,
    ];

    public function __construct(private readonly Connection $db)
    {
    }

    /**
     * @return array{
     *   generated_at: string,
     *   read_only: true,
     *   wallets_checked: int,
     *   entries_checked: int,
     *   findings: list<array<string,mixed>>,
     *   info: list<array<string,mixed>>,
     * }
     */
    public function run(int $staleHours = 48): array
    {
        $this->db->beginTransaction();
        try {
            // Must be the first statement of the transaction: one snapshot, and no writes possible.
            $this->db->executeStatement('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');

            $wallets = (int) $this->db->fetchOne('SELECT COUNT(*) FROM wallets');
            $entries = (int) $this->db->fetchOne('SELECT COUNT(*) FROM wallet_transactions');

            $findings = [];
            $repeats  = [];
            foreach ($this->balanceMismatches() as $mismatch) {
                foreach ($mismatch['breaks'] as $break) {
                    if (($break['repeat_times'] ?? null) !== null) {
                        $repeats[] = [
                            'kind'         => 'repeat_credit_suspected',
                            'reference'    => $break['repeat_reference'],
                            'wallet_id'    => $mismatch['wallet_id'],
                            'patient_id'   => $mismatch['patient_id'],
                            'currency'     => $mismatch['currency'],
                            'amount'       => $break['repeat_amount'],
                            'times'        => $break['repeat_times'],
                            'located_at'   => $break['reference'],
                            'summary'      => sprintf(
                                '%s looks credited %d times (%s %s each; %s %s too much)%s',
                                $break['repeat_reference'],
                                $break['repeat_times'],
                                $mismatch['currency'],
                                $break['repeat_amount'],
                                $mismatch['currency'],
                                $break['unexplained'],
                                $break['repeat_reference'] !== $break['reference']
                                    ? sprintf(' — the jump shows on %s, which posted between its credits', $break['reference'])
                                    : '',
                            ),
                        ];
                    }
                }
                $findings[] = $mismatch;
            }
            array_push(
                $findings,
                ...$repeats,
                ...$this->postedButNotSuccess(),
                ...$this->duplicateProviderCredits(),
                ...$this->ledgerAnomalies(),
                ...$this->heldTopups(),
                ...$this->topupAmountDifferences(),
            );

            return [
                'generated_at'    => gmdate(DATE_ATOM),
                'read_only'       => true,
                'wallets_checked' => $wallets,
                'entries_checked' => $entries,
                'findings'        => $findings,
                'info'            => $this->info($staleHours),
            ];
        } finally {
            $this->db->rollBack();
        }
    }

    /** @return list<array<string,mixed>> */
    private function balanceMismatches(): array
    {
        $rows = $this->db->fetchAllAssociative(
            "SELECT w.id, w.patient_id, w.currency, w.balance::text AS balance, COALESCE(l.ledger, 0)::text AS ledger
               FROM wallets w
               LEFT JOIN (
                    SELECT wallet_id,
                           SUM(CASE WHEN direction = 'credit' THEN amount WHEN direction = 'debit' THEN -amount ELSE 0 END) AS ledger
                      FROM wallet_transactions
                     WHERE status = 'success'
                     GROUP BY wallet_id
               ) l ON l.wallet_id = w.id
              WHERE w.balance <> COALESCE(l.ledger, 0)
              ORDER BY ABS(w.balance - COALESCE(l.ledger, 0)) DESC, w.id",
        );

        $out = [];
        foreach ($rows as $row) {
            $balance    = self::money((string) $row['balance']);
            $ledger     = self::money((string) $row['ledger']);
            $difference = bcsub($balance, $ledger, self::SCALE);
            // Every entry that moved this wallet's balance — including pre-fix rows
            // left pending/failed after posting, so the chain doesn't break on (and
            // blame) the next legitimate entry.
            $entries = $this->db->fetchAllAssociative(
                "SELECT id, reference, type, direction, status, amount::text AS amount, balance_after::text AS balance_after,
                        to_char(posted_at, 'YYYY-MM-DD HH24:MI:SS') AS posted_at,
                        to_char(created_at, 'YYYY-MM-DD HH24:MI:SS') AS created_at
                   FROM wallet_transactions
                  WHERE wallet_id = ? AND " . self::MOVED_MONEY,
                [$row['id']],
            );
            $unrestored      = array_values(array_filter($entries, static fn (array $e): bool => $e['status'] !== WalletTransaction::STATUS_SUCCESS));
            $unrestoredTotal = '0.00';
            foreach ($unrestored as $e) {
                $unrestoredTotal = self::after($unrestoredTotal, $e);
            }
            $summary = sprintf(
                'wallet %s (patient %s, %s): balance %s but ledger %s — %s%s %s the ledger',
                $row['id'],
                $row['patient_id'],
                $row['currency'],
                $balance,
                $ledger,
                bccomp($difference, '0', self::SCALE) > 0 ? '+' : '',
                $difference,
                bccomp($difference, '0', self::SCALE) > 0 ? 'above' : 'below',
            );
            if ($unrestored !== []) {
                $summary .= sprintf(
                    '; %s of it is %s that moved money but %s not marked success (%s) — restore %s first (see posted_entry_not_success)',
                    $unrestoredTotal,
                    count($unrestored) === 1 ? 'an entry' : count($unrestored) . ' entries',
                    count($unrestored) === 1 ? 'is' : 'are',
                    implode(', ', array_map(static fn (array $e): string => (string) $e['reference'], $unrestored)),
                    count($unrestored) === 1 ? 'it' : 'them',
                );
            }
            $out[] = [
                'kind'             => 'balance_mismatch',
                'wallet_id'        => (string) $row['id'],
                'patient_id'       => (string) $row['patient_id'],
                'currency'         => (string) $row['currency'],
                'balance'          => $balance,
                'ledger'           => $ledger,
                'difference'       => $difference,
                'unrestored'       => array_map(static fn (array $e): string => (string) $e['reference'], $unrestored),
                'unrestored_total' => $unrestoredTotal,
                'breaks'           => self::chainBreaks($entries),
                'summary'          => $summary,
            ];
        }

        return $out;
    }

    /**
     * Where a wallet's running balance stops adding up: walks the entries that
     * moved its balance in posting order (entries posted within the same second
     * are put in the order that breaks the chain least) and reports each entry
     * whose recorded `balance_after` is not the previous balance ± its amount.
     *
     * Repeat credits (`repeat_reference` credited `repeat_times` times, at
     * `repeat_amount` each):
     *  - a top-up credit whose own jump is a whole multiple of its amount;
     *  - a break on any OTHER entry with money unexplained (+): the old race's
     *    likeliest trace — a top-up credited, this entry posted, then the same
     *    top-up credited again, which overwrote the top-up's balance_after and
     *    posted_at so it now chains cleanly and the jump lands here. Suspects:
     *    the wallet's top-ups started (created_at) no later than this entry
     *    posted, last posted no earlier than it, whose amount divides the
     *    unexplained amount exactly. Exactly one suspect → it is named; several
     *    → listed in `suspects`, none accused.
     * Pure function (unit-tested).
     *
     * @param list<array<string,mixed>> $entries rows with id, reference, type, direction, amount, balance_after, posted_at, created_at
     * @return list<array{reference:string, type:string, direction:string, amount:string, at:string, expected_after:string, recorded_after:string, unexplained:string, repeat_times:?int, repeat_reference:?string, repeat_amount:?string, suspects:list<string>}>
     */
    public static function chainBreaks(array $entries, string $opening = '0.00'): array
    {
        usort($entries, static fn (array $a, array $b): int => [self::when($a), (string) $a['created_at'], (string) $a['id']]
            <=> [self::when($b), (string) $b['created_at'], (string) $b['id']]);

        // Group entries posted in the same second (the column has second precision).
        $groups = [];
        foreach ($entries as $entry) {
            $key = self::when($entry);
            if ($groups === [] || array_key_last($groups) !== $key) {
                $groups[$key] = [];
            }
            $groups[$key][] = $entry;
        }

        $previous = self::money($opening);
        $breaks   = [];
        foreach ($groups as $group) {
            // Same-second entries: their true order is the one that breaks the
            // chain least — try every order of a small group (≤ 6! = 720 walks).
            $best = null;
            foreach (count($group) <= 6 ? self::orders($group) : [$group] as $order) {
                $walk = self::walk($previous, $order);
                if ($best === null || count($walk[1]) < count($best[1])) {
                    $best = $walk;
                }
            }
            [$previous, $groupBreaks] = $best ?? [$previous, []];
            array_push($breaks, ...$groupBreaks);
        }

        return self::attributeRepeats($breaks, $entries);
    }

    /**
     * Name the top-up behind a positive break on a non-top-up entry (see chainBreaks()).
     *
     * @param list<array<string,mixed>> $breaks
     * @param list<array<string,mixed>> $entries
     * @return list<array<string,mixed>>
     */
    private static function attributeRepeats(array $breaks, array $entries): array
    {
        foreach ($breaks as $i => $break) {
            if ($break['repeat_times'] !== null || bccomp($break['unexplained'], '0', self::SCALE) <= 0) {
                continue;
            }
            $suspects = [];
            foreach ($entries as $entry) {
                $amount = self::money((string) $entry['amount']);
                if ($entry['type'] !== WalletTransaction::TYPE_TOPUP
                    || $entry['direction'] !== WalletTransaction::DIR_CREDIT
                    || (string) $entry['reference'] === $break['reference']
                    || bccomp($amount, '0', self::SCALE) <= 0
                    || (string) $entry['created_at'] > $break['at'] // started after this entry posted
                    || self::when($entry) < $break['at']) {         // last posted before it
                    continue;
                }
                $multiple = bcdiv($break['unexplained'], $amount, 0);
                if (bccomp($multiple, '1', 0) >= 0 && bccomp(bcmul($multiple, $amount, self::SCALE), $break['unexplained'], self::SCALE) === 0) {
                    $suspects[] = ['reference' => (string) $entry['reference'], 'amount' => $amount, 'times' => (int) $multiple + 1];
                }
            }
            $breaks[$i]['suspects'] = array_column($suspects, 'reference');
            if (count($suspects) === 1) {
                $breaks[$i]['repeat_times']     = $suspects[0]['times'];
                $breaks[$i]['repeat_reference'] = $suspects[0]['reference'];
                $breaks[$i]['repeat_amount']    = $suspects[0]['amount'];
            }
        }

        return $breaks;
    }

    /**
     * Walk entries in the given order from `$previous`.
     *
     * @param list<array<string,mixed>> $entries
     * @return array{0: string, 1: list<array<string,mixed>>} the balance after them, and the breaks
     */
    private static function walk(string $previous, array $entries): array
    {
        $breaks = [];
        foreach ($entries as $entry) {
            $expected = self::after($previous, $entry);
            if ($entry['balance_after'] === null) {
                $previous = $expected; // reported as a ledger anomaly; keep walking
                continue;
            }
            $recorded = self::money((string) $entry['balance_after']);
            if (bccomp($recorded, $expected, self::SCALE) === 0) {
                $previous = $recorded;
                continue;
            }

            $amount      = self::money((string) $entry['amount']);
            $unexplained = bcsub($recorded, $expected, self::SCALE);
            $times       = null;
            if ($entry['type'] === WalletTransaction::TYPE_TOPUP
                && $entry['direction'] === WalletTransaction::DIR_CREDIT
                && bccomp($unexplained, '0', self::SCALE) > 0
                && bccomp($amount, '0', self::SCALE) > 0) {
                $multiple = bcdiv($unexplained, $amount, 0);
                if (bccomp(bcmul($multiple, $amount, self::SCALE), $unexplained, self::SCALE) === 0) {
                    $times = (int) $multiple + 1;
                }
            }
            $breaks[] = [
                'reference'        => (string) $entry['reference'],
                'type'             => (string) $entry['type'],
                'direction'        => (string) $entry['direction'],
                'amount'           => $amount,
                'at'               => self::when($entry),
                'expected_after'   => $expected,
                'recorded_after'   => $recorded,
                'unexplained'      => $unexplained,
                'repeat_times'     => $times,
                'repeat_reference' => $times !== null ? (string) $entry['reference'] : null,
                'repeat_amount'    => $times !== null ? $amount : null,
                'suspects'         => $times !== null ? [(string) $entry['reference']] : [],
            ];
            $previous = $recorded;
        }

        return [$previous, $breaks];
    }

    /**
     * Every ordering of `$items`, the given order first.
     *
     * @param list<array<string,mixed>> $items
     * @return \Generator<int, list<array<string,mixed>>>
     */
    private static function orders(array $items): \Generator
    {
        if (count($items) <= 1) {
            yield $items;

            return;
        }
        foreach ($items as $i => $item) {
            $rest = $items;
            unset($rest[$i]);
            foreach (self::orders(array_values($rest)) as $tail) {
                yield [$item, ...$tail];
            }
        }
    }

    /**
     * Entries that moved the balance but are not marked success: the pre-fix
     * late-failure race (a stale "charge failed" flushed over a credit that had
     * just landed rewrote only `status`). The money IS in the wallet; the ledger
     * just doesn't count it. Settling never credits them again; support
     * restores them (WalletService::restorePostedTopup — no balance change).
     *
     * @return list<array<string,mixed>>
     */
    private function postedButNotSuccess(): array
    {
        $rows = $this->db->fetchAllAssociative(
            "SELECT reference, wallet_id, patient_id, type, direction, status, amount::text AS amount, currency,
                    balance_after::text AS balance_after, provider_reference,
                    to_char(posted_at, 'YYYY-MM-DD HH24:MI:SS') AS posted_at
               FROM wallet_transactions
              WHERE " . self::POSTED_NOT_SUCCESS . '
              ORDER BY created_at, reference',
        );

        return array_map(static function (array $r): array {
            $topup    = $r['type'] === WalletTransaction::TYPE_TOPUP && $r['direction'] === WalletTransaction::DIR_CREDIT;
            $complete = $r['posted_at'] !== null && $r['balance_after'] !== null;

            return [
                'kind'               => 'posted_entry_not_success',
                'reference'          => (string) $r['reference'],
                'wallet_id'          => (string) $r['wallet_id'],
                'patient_id'         => (string) $r['patient_id'],
                'status'             => (string) $r['status'],
                'amount'             => self::money((string) $r['amount']),
                'currency'           => (string) $r['currency'],
                'provider_reference' => $r['provider_reference'],
                'summary'            => sprintf(
                    '%s (%s %s %s %s, patient %s): marked %s but it moved the balance (posted %s, balance after %s) — %s',
                    $r['reference'],
                    $r['type'],
                    $r['direction'],
                    $r['currency'],
                    self::money((string) $r['amount']),
                    $r['patient_id'],
                    $r['status'],
                    $r['posted_at'] ?? '?',
                    $r['balance_after'] ?? '?',
                    $topup && $complete
                        ? 'the money is in the wallet: restore it with restorePostedTopup() (no balance change); never credit it again or claw it back'
                        : 'incomplete or not a top-up: escalate to engineering',
                ),
            ];
        }, $rows);
    }

    /** @return list<array<string,mixed>> */
    private function duplicateProviderCredits(): array
    {
        $rows = $this->db->fetchAllAssociative(
            "SELECT provider, provider_reference, COUNT(*) AS n, string_agg(reference, ', ' ORDER BY reference) AS refs,
                    SUM(amount)::text AS total, MIN(currency) AS currency
               FROM wallet_transactions
              WHERE " . self::MOVED_MONEY . " AND direction = 'credit' AND provider_reference IS NOT NULL AND provider_reference <> ''
              GROUP BY provider, provider_reference
             HAVING COUNT(*) > 1
              ORDER BY provider_reference",
        );

        return array_map(static fn (array $r): array => [
            'kind'               => 'duplicate_provider_credit',
            'provider'           => $r['provider'],
            'provider_reference' => (string) $r['provider_reference'],
            'references'         => (string) $r['refs'],
            'count'              => (int) $r['n'],
            'summary'            => sprintf(
                '%s transaction %s credited %d times (%s; %s %s in total)',
                $r['provider'] ?? 'gateway',
                $r['provider_reference'],
                (int) $r['n'],
                $r['refs'],
                $r['currency'],
                self::money((string) $r['total']),
            ),
        ], $rows);
    }

    /** @return list<array<string,mixed>> */
    private function ledgerAnomalies(): array
    {
        $known = implode(', ', array_map(static fn (string $s): string => "'" . $s . "'", self::KNOWN_STATUSES));
        $rows  = $this->db->fetchAllAssociative(
            "SELECT t.reference, t.wallet_id, t.status, t.direction, t.amount::text AS amount, t.currency,
                    CASE
                      WHEN w.id IS NULL THEN 'entry has no wallet'
                      WHEN t.currency <> w.currency THEN 'currency differs from its wallet (' || w.currency || ')'
                      WHEN t.patient_id <> w.patient_id THEN 'patient differs from its wallet''s'
                      WHEN t.direction NOT IN ('credit', 'debit') THEN 'unknown direction'
                      WHEN t.status NOT IN ({$known}) THEN 'unknown status'
                      WHEN t.amount <= 0 THEN 'non-positive amount'
                      ELSE 'posted without balance_after/posted_at'
                    END AS problem
               FROM wallet_transactions t
               LEFT JOIN wallets w ON w.id = t.wallet_id
              WHERE w.id IS NULL
                 OR t.currency <> w.currency
                 OR t.patient_id <> w.patient_id
                 OR t.direction NOT IN ('credit', 'debit')
                 OR t.status NOT IN ({$known})
                 OR t.amount <= 0
                 OR (t.status = 'success' AND (t.balance_after IS NULL OR t.posted_at IS NULL))
              ORDER BY t.created_at, t.reference",
        );

        return array_map(static fn (array $r): array => [
            'kind'      => 'ledger_anomaly',
            'reference' => (string) $r['reference'],
            'wallet_id' => (string) $r['wallet_id'],
            'problem'   => (string) $r['problem'],
            'summary'   => sprintf('%s (%s %s %s %s): %s', $r['reference'], $r['status'], $r['direction'], $r['currency'], $r['amount'], $r['problem']),
        ], $rows);
    }

    /** @return list<array<string,mixed>> */
    private function heldTopups(): array
    {
        $rows = $this->db->fetchAllAssociative(
            "SELECT reference, wallet_id, patient_id, amount::text AS amount, currency, provider_reference,
                    metadata::text AS metadata, to_char(created_at, 'YYYY-MM-DD HH24:MI:SS') AS created_at
               FROM wallet_transactions
              WHERE status = ?
              ORDER BY created_at, reference",
            [WalletTransaction::STATUS_REVIEW],
        );

        return array_map(static function (array $r): array {
            $meta   = json_decode((string) ($r['metadata'] ?? ''), true);
            $review = is_array($meta) && is_array($meta['review'] ?? null) ? $meta['review'] : [];
            $paid   = isset($review['verified_amount_minor'])
                ? sprintf('%s %s', $review['verified_currency'] ?? '?', bcdiv((string) $review['verified_amount_minor'], '100', self::SCALE))
                : 'unknown';

            return [
                'kind'               => 'topup_held_for_review',
                'reference'          => (string) $r['reference'],
                'wallet_id'          => (string) $r['wallet_id'],
                'patient_id'         => (string) $r['patient_id'],
                'expected'           => sprintf('%s %s', $r['currency'], self::money((string) $r['amount'])),
                'paid'               => $paid,
                'provider_reference' => $r['provider_reference'],
                'summary'            => sprintf(
                    '%s (patient %s, started %s): expected %s %s, Paystack verified %s — not credited, needs support',
                    $r['reference'],
                    $r['patient_id'],
                    $r['created_at'],
                    $r['currency'],
                    self::money((string) $r['amount']),
                    $paid,
                ),
            ];
        }, $rows);
    }

    /** @return list<array<string,mixed>> */
    private function topupAmountDifferences(): array
    {
        $rows = $this->db->fetchAllAssociative(
            "SELECT reference, amount::text AS amount, currency,
                    metadata->>'verified_amount_minor' AS verified_minor, metadata->>'verified_currency' AS verified_currency
               FROM wallet_transactions
              WHERE type = 'topup' AND direction = 'credit' AND status = 'success'
                AND metadata IS NOT NULL AND (metadata->>'verified_amount_minor') IS NOT NULL
              ORDER BY created_at, reference",
        );

        $out = [];
        foreach ($rows as $r) {
            $expected = WalletService::minorUnits(self::money((string) $r['amount']));
            $verified = (string) $r['verified_minor'];
            $sameAmount = preg_match('/^\d+$/', $verified) === 1 && bccomp($verified, $expected, 0) === 0;
            if ($sameAmount && strtoupper((string) $r['verified_currency']) === (string) $r['currency']) {
                continue;
            }
            $out[] = [
                'kind'      => 'topup_amount_differs',
                'reference' => (string) $r['reference'],
                'summary'   => sprintf(
                    '%s credited %s %s but Paystack verified %s minor units of %s',
                    $r['reference'],
                    $r['currency'],
                    self::money((string) $r['amount']),
                    $verified,
                    $r['verified_currency'] ?? '?',
                ),
            ];
        }

        return $out;
    }

    /** @return list<array<string,mixed>> */
    private function info(int $staleHours): array
    {
        $cutoff = (new \DateTimeImmutable(sprintf('-%d hours', max(1, $staleHours))))->format('Y-m-d H:i:s');
        // Never-posted only: a row that moved money is a posted_entry_not_success finding, not "unsettled".
        $unsettled = "type = 'topup' AND direction = 'credit' AND status IN ('pending', 'failed') AND posted_at IS NULL AND balance_after IS NULL AND created_at < ?";
        $stale     = $this->db->fetchAllAssociative(
            "SELECT reference, patient_id, status, amount::text AS amount, currency, to_char(created_at, 'YYYY-MM-DD HH24:MI:SS') AS created_at
               FROM wallet_transactions
              WHERE {$unsettled}
              ORDER BY created_at DESC, reference
              LIMIT 20",
            [$cutoff],
        );
        $staleCount = (int) $this->db->fetchOne("SELECT COUNT(*) FROM wallet_transactions WHERE {$unsettled}", [$cutoff]);
        $unverified = (int) $this->db->fetchOne(
            "SELECT COUNT(*) FROM wallet_transactions
              WHERE type = 'topup' AND direction = 'credit' AND status = 'success'
                AND (metadata IS NULL OR (metadata->>'verified_amount_minor') IS NULL)",
        );

        $info = [];
        if ($staleCount > 0) {
            $info[] = [
                'kind'    => 'stale_unsettled_topups',
                'count'   => $staleCount,
                'latest'  => array_map(static fn (array $r): string => sprintf(
                    '%s %s %s %s (%s, patient %s)',
                    $r['reference'],
                    $r['currency'],
                    self::money((string) $r['amount']),
                    $r['status'],
                    $r['created_at'],
                    $r['patient_id'],
                ), $stale),
                'summary' => sprintf(
                    '%d top-up(s) never credited and still pending/failed after %dh — mostly abandoned checkouts. Paystack does NOT resend a missed webhook: bin/wallet-topup-sweep.php --run (nightly) asks Paystack about each and credits the paid ones through settleTopup; for ones older than its window run it once with --max-age-days=0. Never credit() a top-up by hand',
                    $staleCount,
                    $staleHours,
                ),
            ];
        }
        if ($unverified > 0) {
            $info[] = [
                'kind'    => 'topups_credited_before_amount_check',
                'count'   => $unverified,
                'summary' => sprintf(
                    '%d top-up(s) were credited before the amount/currency check existed (no verified amount recorded) — compare them with a Paystack transaction export if in doubt',
                    $unverified,
                ),
            ];
        }

        return $info;
    }

    /** @param array<string,mixed> $entry */
    private static function after(string $previous, array $entry): string
    {
        $amount = self::money((string) $entry['amount']);

        return match ($entry['direction']) {
            WalletTransaction::DIR_CREDIT => bcadd($previous, $amount, self::SCALE),
            WalletTransaction::DIR_DEBIT  => bcsub($previous, $amount, self::SCALE),
            default                       => $previous,
        };
    }

    /** @param array<string,mixed> $entry */
    private static function when(array $entry): string
    {
        return (string) ($entry['posted_at'] ?? $entry['created_at']);
    }

    private static function money(string $value): string
    {
        $value = trim($value);

        return bcadd($value === '' ? '0' : $value, '0', self::SCALE);
    }
}
