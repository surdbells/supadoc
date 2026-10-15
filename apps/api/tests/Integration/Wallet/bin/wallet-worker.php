<?php

declare(strict_types=1);

/**
 * One "request" in a wallet race, run as its own OS process with its own
 * database session (see the *ConcurrencyTest classes). Like the real verify
 * action / webhook, it first loads the ledger entry (so it holds an in-memory
 * copy that goes stale the moment another process commits), then performs the
 * money operation. Prints one JSON line with what happened.
 *
 * argv[1] = base64(JSON job): {schema, app, op: settle|credit|fail, reference,
 *            amount_minor?, currency?, patient_id?, amount?}
 */

use App\Tests\Integration\Wallet\Support\WalletHarness;
use Monolog\Handler\TestHandler;

require __DIR__ . '/../../../../vendor/autoload.php';

$job = json_decode((string) base64_decode($argv[1] ?? '', true), true);
if (!is_array($job)) {
    fwrite(STDERR, "bad job\n");
    exit(2);
}

$result = ['op' => $job['op'], 'posted' => false, 'error' => null];
try {
    $em      = WalletHarness::entityManager((string) $job['schema'], (string) $job['app']);
    $mail    = new TestHandler();
    $wallets = WalletHarness::walletService($em, $mail);

    switch ($job['op']) {
        case 'settle':
            // The stale copy a request holds before its slow gateway call.
            $em->getRepository(App\Domain\Entity\WalletTransaction::class)->findOneBy(['reference' => $job['reference']]);
            $posted           = $wallets->settleTopup((string) $job['reference'], (string) $job['amount_minor'], (string) $job['currency'], 'gw_' . getmypid());
            $result['posted'] = $posted !== null;
            break;

        case 'credit':
            $before           = $em->getConnection()->fetchOne('SELECT COUNT(*) FROM wallet_transactions WHERE reference = ?', [$job['reference']]);
            $txn              = $wallets->credit((string) $job['patient_id'], 'NGN', (string) $job['amount'], 'refund', (string) $job['reference'], 'Integration race');
            $result['posted'] = $txn->isSuccess();
            $result['before'] = (int) $before;
            break;

        case 'fail':
            $em->getRepository(App\Domain\Entity\WalletTransaction::class)->findOneBy(['reference' => $job['reference']]);
            $result['posted'] = $wallets->failTopup((string) $job['reference']);
            break;

        default:
            throw new InvalidArgumentException('unknown op');
    }
    $result['receipts'] = WalletHarness::receipts($mail);
} catch (Throwable $e) {
    $result['error'] = get_class($e) . ': ' . $e->getMessage();
}

fwrite(STDOUT, json_encode($result) . PHP_EOL);
exit(0);
