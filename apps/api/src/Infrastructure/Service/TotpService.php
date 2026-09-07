<?php

declare(strict_types=1);

namespace App\Infrastructure\Service;

/**
 * RFC 6238 time-based one-time passwords (SHA-1, 6 digits, 30s step) — the scheme
 * every authenticator app (Google Authenticator, Authy, 1Password…) speaks. Pure
 * PHP, no dependencies, so it is fully unit-testable offline against the RFC's own
 * test vectors.
 */
final class TotpService
{
    private const PERIOD = 30;
    private const DIGITS = 6;
    private const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

    /** A fresh random base32 secret (default 160-bit, per the RFC recommendation). */
    public function generateSecret(int $bytes = 20): string
    {
        return $this->base32Encode(random_bytes($bytes));
    }

    /**
     * Verify a code against the secret, allowing ±$window steps of clock drift
     * (default ±1 = ±30s). Constant-time comparison per candidate.
     */
    public function verify(string $secret, string $code, int $window = 1, ?int $at = null): bool
    {
        $code = preg_replace('/\D/', '', $code) ?? '';
        if (strlen($code) !== self::DIGITS) {
            return false;
        }
        $counter = (int) floor(($at ?? time()) / self::PERIOD);
        for ($w = -$window; $w <= $window; $w++) {
            if (hash_equals($this->hotp($secret, $counter + $w), $code)) {
                return true;
            }
        }

        return false;
    }

    /** The `otpauth://` URI an authenticator app scans (or the secret is keyed in). */
    public function provisioningUri(string $secret, string $account, string $issuer): string
    {
        $label = rawurlencode($issuer) . ':' . rawurlencode($account);
        $query = http_build_query([
            'secret'    => $secret,
            'issuer'    => $issuer,
            'algorithm' => 'SHA1',
            'digits'    => self::DIGITS,
            'period'    => self::PERIOD,
        ]);

        return "otpauth://totp/{$label}?{$query}";
    }

    /** One HOTP value for a counter (RFC 4226 dynamic truncation). */
    private function hotp(string $secret, int $counter): string
    {
        $key    = $this->base32Decode($secret);
        $binCtr = pack('N*', 0) . pack('N*', $counter); // 8-byte big-endian counter
        $hash   = hash_hmac('sha1', $binCtr, $key, true);
        $offset = ord($hash[strlen($hash) - 1]) & 0x0f;
        $binary = ((ord($hash[$offset]) & 0x7f) << 24)
            | ((ord($hash[$offset + 1]) & 0xff) << 16)
            | ((ord($hash[$offset + 2]) & 0xff) << 8)
            | (ord($hash[$offset + 3]) & 0xff);

        return str_pad((string) ($binary % (10 ** self::DIGITS)), self::DIGITS, '0', STR_PAD_LEFT);
    }

    private function base32Encode(string $data): string
    {
        $out  = '';
        $bits = 0;
        $val  = 0;
        foreach (str_split($data) as $ch) {
            $val = ($val << 8) | ord($ch);
            $bits += 8;
            while ($bits >= 5) {
                $bits -= 5;
                $out .= self::ALPHABET[($val >> $bits) & 0x1f];
            }
        }
        if ($bits > 0) {
            $out .= self::ALPHABET[($val << (5 - $bits)) & 0x1f];
        }

        return $out;
    }

    private function base32Decode(string $secret): string
    {
        $secret = strtoupper(preg_replace('/[^A-Z2-7]/', '', $secret) ?? '');
        $out    = '';
        $bits   = 0;
        $val    = 0;
        $len    = strlen($secret);
        for ($i = 0; $i < $len; $i++) {
            $val = ($val << 5) | strpos(self::ALPHABET, $secret[$i]);
            $bits += 5;
            if ($bits >= 8) {
                $bits -= 8;
                $out .= chr(($val >> $bits) & 0xff);
            }
        }

        return $out;
    }
}
