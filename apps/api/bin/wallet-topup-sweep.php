<?php

declare(strict_types=1);

/**
 * Re-check never-credited wallet top-ups with Paystack — a DRY RUN unless --run.
 *
 *   php bin/wallet-topup-sweep.php                         # dry run: asks Paystack, changes nothing
 *   php bin/wallet-topup-sweep.php --run                   # credit the ones Paystack says were paid
 *   php bin/wallet-topup-sweep.php --run --max-age-days=0  # one-off backfill: every never-credited top-up
 *
 * Options: --min-age-minutes=N (default 15) --max-age-days=N (default 30; 0 = no limit)
 *          --limit=N (default 1000, newest first; 0 = no limit) --pause-ms=N (default 150) --json
 *
 * Looks at top-ups still pending/failed that never moved money, asks Paystack
 * about each (GET /transaction/verify), and with --run credits a paid one
 * through WalletService::settleTopup(): at most once, only when the amount and
 * currency are exactly what the top-up asked for (otherwise it is held for
 * support, nothing credited), with the receipt + in-app notice. Rows that
 * already moved money, held/resolved rows and anything else are never touched,
 * and nothing is ever marked failed. Safe to run at any time, repeatedly and
 * alongside the webhook / patients verifying.
 *
 * Exit codes: 0 = done (dry run: nothing would change), 1 = dry run found
 * payments to credit/hold, or some top-ups could not be checked, 2 = could not run.
 */

use App\Domain\Repository\WalletTransactionRepository;
use App\Infrastructure\Service\PaystackService;
use App\Infrastructure\Service\WalletService;
use App\Infrastructure\Service\WalletTopupSweeper;
use DI\ContainerBuilder;
use Doctrine\ORM\EntityManagerInterface;

require __DIR__ . '/../vendor/autoload.php';

Dotenv\Dotenv::createImmutable(__DIR__ . '/..')->safeLoad();

$args = array_slice($argv, 1);
if (in_array('--help', $args, true) || in_array('-h', $args, true)) {
    fwrite(STDOUT, "Usage: php bin/wallet-topup-sweep.php [--run] [--json] [--min-age-minutes=15] [--max-age-days=30] [--limit=1000] [--pause-ms=150]\n"
        . "Dry run unless --run. Exit 0 = done, 1 = dry run found work / some not checked, 2 = error.\n");
    exit(0);
}
$apply   = false;
$json    = false;
$options = ['min-age-minutes' => 15, 'max-age-days' => 30, 'limit' => 1000, 'pause-ms' => 150];
foreach ($args as $arg) {
    if ($arg === '--run') {
        $apply = true;
    } elseif ($arg === '--json') {
        $json = true;
    } elseif (preg_match('/^--(min-age-minutes|max-age-days|limit|pause-ms)=(\d{1,7})$/', $arg, $m) === 1) {
        $options[$m[1]] = (int) $m[2];
    } else {
        fwrite(STDERR, "Unknown option: {$arg} (see --help)\n");
        exit(2);
    }
}

try {
    $container = (new ContainerBuilder())->addDefinitions(__DIR__ . '/../config/container.php')->build();
    $paystack  = $container->get(PaystackService::class);
    if (!$paystack->isConfigured()) {
        throw new \RuntimeException('PAYSTACK_SECRET_KEY is not set');
    }
    $sweeper = new WalletTopupSweeper(
        $container->get(EntityManagerInterface::class),
        $container->get(WalletService::class),
        $container->get(WalletTransactionRepository::class),
        $paystack,
    );
    $report = $sweeper->sweep($apply, $options['min-age-minutes'], $options['max-age-days'], $options['limit'], $options['pause-ms']);
} catch (\Throwable $e) {
    fwrite(STDERR, sprintf("wallet-topup-sweep: could not run: %s\n", $e->getMessage()));
    exit(2);
}

$counts = array_count_values(array_column($report['results'], 'outcome'));
$work   = ($counts['would_credit'] ?? 0) + ($counts['would_hold_for_review'] ?? 0);
$failed = ($counts['gateway_error'] ?? 0) + ($counts['error'] ?? 0) + ($report['stopped'] !== null ? 1 : 0);
$exit   = $failed > 0 || (!$apply && $work > 0) ? 1 : 0;

if ($json) {
    fwrite(STDOUT, json_encode($report + ['counts' => $counts, 'options' => $options], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . PHP_EOL);
    exit($exit);
}

$out   = [];
$out[] = sprintf('Wallet top-up sweep — %s — %s', gmdate(DATE_ATOM), $apply ? 'APPLYING (--run)' : 'DRY RUN: nothing will be changed');
$out[] = sprintf(
    'Never-credited pending/failed top-ups older than %d min%s: %d; checked %d with Paystack.',
    $options['min-age-minutes'],
    $options['max-age-days'] > 0 ? sprintf(' and started within %d days', $options['max-age-days']) : '',
    $report['candidates'],
    $report['checked'],
);
foreach ($report['results'] as $r) {
    if (in_array($r['outcome'], ['not_paid', 'still_processing'], true)) {
        continue; // the usual abandoned checkout — counted below
    }
    $out[] = sprintf('  %-22s %s (%s %s, %s, started %s) — %s', $r['outcome'], $r['reference'], $r['currency'], $r['amount'], $r['status'], $r['created_at'], $r['detail']);
}
ksort($counts);
$out[] = 'Outcomes: ' . ($counts === [] ? 'none' : implode(', ', array_map(static fn (string $k, int $n): string => "{$k} {$n}", array_keys($counts), $counts)));
if ($report['candidates'] > $report['checked'] && $report['stopped'] === null) {
    $out[] = sprintf('%d more not checked this run (raise --limit, or run again).', $report['candidates'] - $report['checked']);
}
if ($report['stopped'] !== null) {
    $out[] = 'STOPPED: ' . $report['stopped'];
}
if (!$apply && $work > 0) {
    $out[] = 'Run again with --run to credit them (each at most once, exact amount only; mismatches are held for support).';
}

fwrite(STDOUT, implode(PHP_EOL, $out) . PHP_EOL);
exit($exit);
