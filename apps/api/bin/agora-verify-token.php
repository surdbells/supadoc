<?php

declare(strict_types=1);

/**
 * Confirms WHICH App Certificate actually signed a live Agora RTC token.
 *
 * An AccessToken2 ("007") carries its own issueTs + salt in the clear, so the
 * HMAC signature can be recomputed for any candidate certificate and compared
 * byte-for-byte against the one baked into the token. The certificate that
 * reproduces the signature is, by definition, the one the token-issuing process
 * used — this proves what the *running* app parsed, not merely what's on disk.
 *
 * Usage (run on the server):
 *   php bin/agora-verify-token.php <token-from-live-/call-token> [extraCert ...]
 *
 * The certificate currently in apps/api/.env is always tested first; pass any
 * other candidate (e.g. the Console Primary) as extra args to compare.
 *
 * @see RtcTokenBuilder2.php for the matching build() algorithm.
 */

require __DIR__ . '/../vendor/autoload.php';

use Dotenv\Dotenv;

function fail(string $msg): never
{
    fwrite(STDERR, $msg . PHP_EOL);
    exit(1);
}

$token = $argv[1] ?? '';
if ($token === '') {
    fail('Usage: php bin/agora-verify-token.php <token> [extraCert ...]');
}

// Candidate certificates: the deployed .env value first, then any CLI args.
$candidates = [];
Dotenv::createImmutable(__DIR__ . '/..')->safeLoad();
$envCert = trim($_ENV['AGORA_APP_CERTIFICATE'] ?? '');
if ($envCert !== '') {
    $candidates['.env'] = $envCert;
}
for ($i = 2; $i < $argc; $i++) {
    $c = trim($argv[$i]);
    if ($c !== '') {
        $candidates['arg#' . ($i - 1)] = $c;
    }
}
if ($candidates === []) {
    fail('No candidate certificates: .env is blank and no extra certs were passed.');
}

// --- decode the token -------------------------------------------------------
if (substr($token, 0, 3) !== '007') {
    fail('Not an AccessToken2 ("007") token.');
}
$raw = base64_decode(substr($token, 3), true);
if ($raw === false) {
    fail('Token body is not valid base64.');
}
$content = @zlib_decode($raw);
if ($content === false) {
    fail('Token body did not inflate (zlib) — is this a full, unmodified token?');
}

// content = packString(signature) . signingInfo
$sigLen      = unpack('v', substr($content, 0, 2))[1];
$signature   = substr($content, 2, $sigLen);
$signingInfo = substr($content, 2 + $sigLen);

// signingInfo = packString(appId) . uint32 issueTs . uint32 expire . uint32 salt . ...
$off      = 0;
$appIdLen = unpack('v', substr($signingInfo, $off, 2))[1];
$off     += 2;
$appId    = substr($signingInfo, $off, $appIdLen);
$off     += $appIdLen;
$issueTs  = unpack('V', substr($signingInfo, $off, 4))[1];
$off     += 4;
$expire   = unpack('V', substr($signingInfo, $off, 4))[1];
$off     += 4;
$salt     = unpack('V', substr($signingInfo, $off, 4))[1];

echo 'Token App ID : ' . $appId . PHP_EOL;
echo 'issueTs (UTC): ' . gmdate('Y-m-d H:i:s', $issueTs) . " ($issueTs)" . PHP_EOL;
echo 'privilege end: ' . gmdate('Y-m-d H:i:s', $issueTs + $expire) . ' UTC (expire=' . $expire . 's)' . PHP_EOL;
echo 'server now   : ' . gmdate('Y-m-d H:i:s') . ' UTC' . PHP_EOL;
echo str_repeat('-', 64) . PHP_EOL;

// --- test each candidate against the token's embedded signature -------------
$match = null;
foreach ($candidates as $label => $cert) {
    $signing  = hash_hmac(
        'sha256',
        pack('V', $salt),
        hash_hmac('sha256', pack('V', $issueTs), $cert, true),
        true,
    );
    $expected = hash_hmac('sha256', $signingInfo, $signing, true);
    $ok       = hash_equals($expected, $signature);
    printf(
        "%-8s sha=%s  %s\n",
        $label,
        substr(hash('sha256', $cert), 0, 16),
        $ok ? 'MATCH  <-- signed this token' : 'no match',
    );
    if ($ok) {
        $match = $label;
    }
}
echo str_repeat('-', 64) . PHP_EOL;
echo $match !== null
    ? "RESULT: this live token was signed with the '$match' certificate.\n"
    : "RESULT: none of the candidate certificates signed this token.\n";
