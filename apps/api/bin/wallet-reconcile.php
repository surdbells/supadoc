<?php

declare(strict_types=1);

/**
 * Wallet reconciliation report — READ-ONLY.
 *
 *   php bin/wallet-reconcile.php                  # human-readable report
 *   php bin/wallet-reconcile.php --json           # machine-readable
 *   php bin/wallet-reconcile.php --stale-hours=72 # "still pending" threshold (default 48)
 *
 * For every wallet it compares wallets.balance with the signed sum of its
 * successful ledger entries, and lists references credited more than once,
 * entries that moved money but aren't marked success (the old late-failure
 * race), gateway transactions credited twice, inconsistent ledger rows, top-ups
 * held for review (paid with a different amount/currency) and credited top-ups
 * whose verified amount differs from what they expected. It NEVER changes data:
 * all queries run in one read-only database transaction that is rolled back.
 *
 * Exit codes: 0 = everything reconciles, 1 = findings to act on, 2 = could not run.
 * How support corrects a finding: DEPLOY.md → "Wallet reconciliation".
 */

use App\Infrastructure\Persistence\DoctrineEntityManagerFactory;
use App\Infrastructure\Service\WalletReconciler;

require __DIR__ . '/../vendor/autoload.php';

Dotenv\Dotenv::createImmutable(__DIR__ . '/..')->safeLoad();

$args = array_slice($argv, 1);
if (in_array('--help', $args, true) || in_array('-h', $args, true)) {
    fwrite(STDOUT, "Usage: php bin/wallet-reconcile.php [--json] [--stale-hours=N]\nRead-only: never changes data. Exit 0 = clean, 1 = findings, 2 = error.\n");
    exit(0);
}
$json       = in_array('--json', $args, true);
$staleHours = 48;
foreach ($args as $arg) {
    if (preg_match('/^--stale-hours=(\d{1,5})$/', $arg, $m) === 1) {
        $staleHours = max(1, (int) $m[1]);
    } elseif ($arg !== '--json') {
        fwrite(STDERR, "Unknown option: {$arg} (see --help)\n");
        exit(2);
    }
}

try {
    $report = (new WalletReconciler(DoctrineEntityManagerFactory::create()->getConnection()))->run($staleHours);
} catch (\Throwable $e) {
    fwrite(STDERR, sprintf("wallet-reconcile: could not run: %s\n", $e->getMessage()));
    exit(2);
}

$clean = $report['findings'] === [];

if ($json) {
    fwrite(STDOUT, json_encode($report + ['clean' => $clean], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . PHP_EOL);
    exit($clean ? 0 : 1);
}

$labels = [
    'balance_mismatch'          => 'Wallet balance differs from its ledger',
    'repeat_credit_suspected'   => 'Reference credited more than once',
    'posted_entry_not_success'  => 'Entry that moved money but is not marked success (old late-failure race; money IS in the wallet)',
    'duplicate_provider_credit' => 'Paystack transaction credited more than once',
    'ledger_anomaly'            => 'Ledger entry inconsistent with its wallet',
    'topup_held_for_review'     => 'Top-up held for support review (paid amount/currency differs; not credited)',
    'topup_amount_differs'      => 'Credited top-up whose verified amount differs from what it expected',
];

$out   = [];
$out[] = sprintf('Wallet reconciliation — %s', $report['generated_at']);
$out[] = 'READ-ONLY: this command never changes data (one read-only database transaction, rolled back).';
$out[] = sprintf('Checked %d wallet(s) and %d ledger entr%s.', $report['wallets_checked'], $report['entries_checked'], $report['entries_checked'] === 1 ? 'y' : 'ies');
$out[] = '';

$byKind = [];
foreach ($report['findings'] as $finding) {
    $byKind[$finding['kind']][] = $finding;
}
foreach ($labels as $kind => $label) {
    $items = $byKind[$kind] ?? [];
    $out[] = sprintf('[%s] %s: %d', $items === [] ? ' OK ' : 'FAIL', $label, count($items));
    foreach ($items as $item) {
        $out[] = '       - ' . $item['summary'];
        foreach ($item['breaks'] ?? [] as $break) {
            $because = '';
            if ($break['repeat_times'] !== null) {
                $because = $break['repeat_reference'] === $break['reference']
                    ? sprintf(' → looks credited %d times', $break['repeat_times'])
                    : sprintf(' → %s looks credited %d times around it', $break['repeat_reference'], $break['repeat_times']);
            } elseif (count($break['suspects']) > 1) {
                $because = ' → one of these top-ups may have been credited twice: ' . implode(', ', $break['suspects']);
            }
            $out[] = sprintf(
                '           running balance breaks at %s (%s %s %s): expected %s after it, recorded %s (%s%s unexplained)%s',
                $break['reference'],
                $break['type'],
                $break['direction'],
                $break['amount'],
                $break['expected_after'],
                $break['recorded_after'],
                bccomp($break['unexplained'], '0', 2) > 0 ? '+' : '',
                $break['unexplained'],
                $because,
            );
        }
    }
}
foreach ($report['info'] as $info) {
    $out[] = '[INFO] ' . $info['summary'];
    foreach ($info['latest'] ?? [] as $line) {
        $out[] = '       - ' . $line;
    }
}

$out[] = '';
if ($clean) {
    $out[] = 'Result: every wallet reconciles with its ledger. Nothing to do.';
} else {
    $out[] = sprintf('Result: %d finding(s) — nothing was changed.', count($report['findings']));
    $out[] = 'To correct (see DEPLOY.md "Wallet reconciliation"): never edit wallets.balance or ledger rows by hand.';
    $out[] = ' - FIRST, entry that moved money but is not marked success: WalletService::restorePostedTopup(<ref>)';
    $out[] = '   (status back to success, NO balance change). Its money is the patient\'s — never credit it again or claw it back.';
    $out[] = ' - then, balance still differs from ledger: an engineer records the difference with WalletService::recordLedgerDiscrepancy(),';
    $out[] = '   then finance decides whether to recover it (WalletService::debit, type "adjustment") or make it good (credit),';
    $out[] = '   each under a reference of its own (e.g. clawback_<ref>, makegood_<wallet_id>_<ref or date>).';
    $out[] = ' - held top-up: check the payment in the Paystack dashboard, then WalletService::resolveHeldTopup()';
    $out[] = '   (credit the amount actually received, or null when it was refunded on Paystack).';
    $out[] = ' - anything else: investigate before changing anything; re-run this command until it exits 0.';
}

fwrite(STDOUT, implode(PHP_EOL, $out) . PHP_EOL);
exit($clean ? 0 : 1);
