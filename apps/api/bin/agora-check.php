<?php

declare(strict_types=1);

/**
 * Agora credential sanity check. Run on whichever server serves the API to
 * diagnose "invalid token, authorized failed" errors WITHOUT printing the
 * secret. It verifies the App ID + App Certificate are well-formed (32-char
 * hex, no stray whitespace, not swapped) and mints a sample token.
 *
 *   php bin/agora-check.php
 */

use App\Infrastructure\Agora\AgoraTokenService;

require __DIR__ . '/../vendor/autoload.php';

Dotenv\Dotenv::createImmutable(__DIR__ . '/..')->safeLoad();

$rawId   = $_ENV['AGORA_APP_ID'] ?? '';
$rawCert = $_ENV['AGORA_APP_CERTIFICATE'] ?? '';
$id      = trim($rawId);
$cert    = trim($rawCert);

$hex32 = static fn (string $v): bool => preg_match('/^[0-9a-fA-F]{32}$/', $v) === 1;
$yn    = static fn (bool $b): string => $b ? 'yes' : 'NO';

echo "=== Agora credential check ===\n\n";

// App ID is public (it ships to the browser), so it's safe to print in full —
// compare it against the App ID shown in the Agora Console.
echo "AGORA_APP_ID\n";
echo "  value:            {$id}\n";
echo '  length:           ' . strlen($id) . " (expected 32)\n";
echo '  looks like hex32: ' . $yn($hex32($id)) . "\n";
echo '  had whitespace:   ' . $yn($rawId !== $id) . "\n\n";

// The certificate is secret — never print it, only its shape.
echo "AGORA_APP_CERTIFICATE\n";
echo '  set:              ' . $yn($cert !== '') . "\n";
echo '  length:           ' . strlen($cert) . " (expected 32)\n";
echo '  looks like hex32: ' . $yn($hex32($cert)) . "\n";
echo '  had whitespace:   ' . $yn($rawCert !== $cert) . "\n\n";

$problems = [];
if ($id === '' || $cert === '') {
    $problems[] = 'One or both values are empty.';
}
if ($id !== '' && !$hex32($id)) {
    $problems[] = 'App ID is not 32 hex chars — wrong value, or you pasted the certificate here.';
}
if ($cert !== '' && !$hex32($cert)) {
    $problems[] = 'App Certificate is not 32 hex chars — wrong value, or you pasted the App ID here.';
}
if ($rawId !== $id || $rawCert !== $cert) {
    $problems[] = 'A value had surrounding whitespace/newline in .env — the app now trims it, but clean up .env too.';
}

if ($id !== '' && $cert !== '' && $hex32($id) && $hex32($cert)) {
    $svc   = new AgoraTokenService($id, $cert);
    $token = $svc->rtcToken('diagnostic-channel', 0, 3600);
    echo "Sample token (channel=diagnostic-channel, uid=0)\n";
    echo '  built:            ' . $yn($token !== '') . "\n";
    echo '  starts with 007:  ' . $yn(str_starts_with($token, '007')) . "\n";
    echo '  length:           ' . strlen($token) . "\n\n";
    echo "The token builds. If Agora still rejects it, the certificate does not\n";
    echo "match this App ID's project, or the certificate isn't the Primary one\n";
    echo "enabled in Console → Project → Config → App Certificate.\n";
} else {
    echo "Skipping token build until the values above are well-formed.\n";
}

if ($problems !== []) {
    echo "\n!! Problems found:\n";
    foreach ($problems as $p) {
        echo "  - {$p}\n";
    }
}
