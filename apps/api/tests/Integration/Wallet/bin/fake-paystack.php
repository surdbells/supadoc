<?php

declare(strict_types=1);

/**
 * Router for `php -S 127.0.0.1:<port> fake-paystack.php` — a LOCAL stand-in
 * for Paystack's GET /transaction/verify/{reference} used by the wallet
 * integration tests (nothing ever reaches the real Paystack).
 *
 * FAKE_PAYSTACK_DIR holds `<reference>.json` (the `data` object to answer
 * with) and receives `calls.log`, one line per verify call. An optional
 * `<reference>.during.json` ({schema, amount_minor, currency}) makes the NEXT
 * call first settle that top-up from its own database session — a webhook
 * landing while the caller waits on Paystack — and is then removed.
 */

$dir  = (string) getenv('FAKE_PAYSTACK_DIR');
$path = (string) parse_url((string) ($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH);
header('Content-Type: application/json');

if ($dir === '' || preg_match('#^/transaction/verify/([A-Za-z0-9_\-]{1,80})$#', $path, $m) !== 1) {
    http_response_code(404);
    echo json_encode(['status' => false, 'message' => 'Not found']);

    return true;
}

file_put_contents($dir . '/calls.log', $m[1] . "\n", FILE_APPEND | LOCK_EX);

$during = $dir . '/' . $m[1] . '.during.json';
if (is_file($during)) {
    $job = json_decode((string) file_get_contents($during), true);
    unlink($during);
    require_once __DIR__ . '/../../../../vendor/autoload.php';
    $em = App\Tests\Integration\Wallet\Support\WalletHarness::entityManager((string) $job['schema'], 'fake_paystack_webhook');
    App\Tests\Integration\Wallet\Support\WalletHarness::walletService($em, new Monolog\Handler\TestHandler())
        ->settleTopup($m[1], (string) $job['amount_minor'], (string) $job['currency'], 'gw_webhook');
    $em->getConnection()->close();
}

$file = $dir . '/' . $m[1] . '.json';
if (!is_file($file)) {
    http_response_code(400);
    echo json_encode(['status' => false, 'message' => 'Transaction reference not found']);

    return true;
}

echo json_encode([
    'status'  => true,
    'message' => 'Verification successful',
    'data'    => json_decode((string) file_get_contents($file), true),
]);

return true;
