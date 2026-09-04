<?php

declare(strict_types=1);

/**
 * Paystack connectivity + credential check. Run on whichever server serves the
 * API to diagnose a 502 from POST /api/portal/wallet/fund WITHOUT printing the
 * secret key. It reads .env exactly as the app does, shows the key's shape and
 * mode (test/live), then (1) does a raw curl probe to expose the true transport
 * cause (DNS / SSL / blocked egress / HTTP status) and (2) runs a real
 * PaystackService::initialize() so you see the exact outcome the action sees.
 *
 *   php bin/paystack-check.php
 */

use App\Infrastructure\Service\PaystackService;

require __DIR__ . '/../vendor/autoload.php';

Dotenv\Dotenv::createImmutable(__DIR__ . '/..')->safeLoad();

$yn = static fn (bool $b): string => $b ? 'yes' : 'NO';

$rawKey  = $_ENV['PAYSTACK_SECRET_KEY'] ?? '';
$key     = trim($rawKey);
$baseUrl = trim($_ENV['PAYSTACK_BASE_URL'] ?? '') !== '' ? trim($_ENV['PAYSTACK_BASE_URL']) : 'https://api.paystack.co';

echo "=== Paystack check ===\n\n";
echo 'Server time (UTC):   ' . gmdate('Y-m-d H:i:s') . " UTC\n";
echo 'PHP curl available:  ' . $yn(function_exists('curl_init')) . "\n";
echo 'OpenSSL/curl SSL:    ' . (curl_version()['ssl_version'] ?? 'unknown') . "\n";
echo 'CA bundle (curl.cainfo/openssl.cafile): '
    . (ini_get('curl.cainfo') ?: (ini_get('openssl.cafile') ?: '(default)')) . "\n\n";

// The key is secret — only ever show its length and the 8-char mode prefix
// (sk_test_ / sk_live_), never the body.
echo "PAYSTACK_SECRET_KEY\n";
echo '  set:               ' . $yn($key !== '') . "\n";
echo '  length:            ' . strlen($key) . "\n";
echo '  mode prefix:       ' . ($key !== '' ? substr($key, 0, 8) : '(none)') . "\n";
echo '  had whitespace:    ' . $yn($rawKey !== $key) . "\n";
echo "  base url:          {$baseUrl}\n\n";

if ($key === '') {
    echo "!! No secret key loaded into this process. If it IS in .env, PHP-FPM\n";
    echo "   is running with a stale env — reload it (systemctl reload php-fpm).\n";

    return;
}

// (1) Raw curl probe — this is what surfaces the REAL cause. PaystackService
// collapses transport failures into a generic message; here we keep errno/error.
echo "--- (1) raw curl probe: POST {$baseUrl}/transaction/initialize ---\n";
$ch = curl_init(rtrim($baseUrl, '/') . '/transaction/initialize');
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_POST           => true,
    CURLOPT_HTTPHEADER     => [
        'Authorization: Bearer ' . $key,
        'Content-Type: application/json',
    ],
    CURLOPT_POSTFIELDS     => json_encode([
        'email'  => 'diagnostic@videomed.test',
        'amount' => 500000, // NGN 5,000 in kobo
    ]),
    CURLOPT_TIMEOUT        => 20,
    CURLOPT_CONNECTTIMEOUT => 8,
]);
$raw    = curl_exec($ch);
$errno  = curl_errno($ch);
$error  = curl_error($ch);
$status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

echo '  curl errno:        ' . $errno . ($error !== '' ? " ({$error})" : '') . "\n";
echo '  http status:       ' . $status . "\n";
echo '  body (trimmed):    ' . substr(is_string($raw) ? $raw : '(no body)', 0, 500) . "\n\n";

if ($errno !== 0) {
    echo "!! Transport failed before Paystack could answer. Common causes:\n";
    echo "   - errno 6  : DNS — the server can't resolve api.paystack.co\n";
    echo "   - errno 7/28: egress blocked / timed out — firewall has no outbound 443\n";
    echo "   - errno 60/77: TLS — missing/stale CA bundle (set curl.cainfo in php.ini)\n\n";
} elseif ($status === 401) {
    echo "!! 401 from Paystack — the secret key is wrong or from the other mode\n";
    echo "   (test key on a live domain, or vice-versa). Check the dashboard key.\n\n";
} elseif ($status >= 400) {
    echo "!! Paystack rejected the request (see message above) — e.g. the currency\n";
    echo "   isn't enabled on the account.\n\n";
}

// (2) The real service path — exactly what FundWalletAction runs.
echo "--- (2) PaystackService::initialize() (real app path) ---\n";
$paystack = new PaystackService(secretKey: $key, publicKey: '', baseUrl: $baseUrl);
try {
    $init = $paystack->initialize(
        'diagnostic@videomed.test',
        500000,
        'NGN',
        'vmw_diag_' . bin2hex(random_bytes(6)),
        'https://app.example.test/dashboard/wallet',
        ['purpose' => 'diagnostic'],
    );
    echo "  result:            OK\n";
    echo '  authorization_url: ' . $init['authorization_url'] . "\n";
    echo "\nInitialize works — funding should succeed. If the app still 502s,\n";
    echo "the running PHP-FPM has a stale env or old code; reload it.\n";
} catch (\Throwable $e) {
    echo '  threw:             ' . $e::class . "\n";
    echo '  message:           ' . $e->getMessage() . "\n";
    echo "\nThis is the exact reason FundWalletAction returns 502. Fix the cause\n";
    echo "shown in probe (1) above.\n";
}
