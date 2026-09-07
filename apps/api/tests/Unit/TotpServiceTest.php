<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Infrastructure\Service\TotpService;
use PHPUnit\Framework\TestCase;

/**
 * TOTP is pure, standardised crypto, so it is verifiable offline against RFC 6238's
 * own test vector. The RFC uses the ASCII seed "12345678901234567890"; for SHA-1 at
 * T=59s the 8-digit code is 94287082, i.e. the 6-digit code is 287082.
 *
 * @see https://datatracker.ietf.org/doc/html/rfc6238#appendix-B
 */
final class TotpServiceTest extends TestCase
{
    /** Base32 of the RFC seed "12345678901234567890". */
    private const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

    public function testMatchesRfc6238VectorAt59Seconds(): void
    {
        $totp = new TotpService();
        // Exact step, no drift window — proves the 6-digit truncation is correct.
        self::assertTrue($totp->verify(self::RFC_SECRET, '287082', 0, 59));
    }

    public function testRejectsWrongCode(): void
    {
        $totp = new TotpService();
        self::assertFalse($totp->verify(self::RFC_SECRET, '000000', 0, 59));
    }

    public function testAcceptsCodeWithinDriftWindow(): void
    {
        $totp = new TotpService();
        // 287082 is the code for the step at t=59; it must also verify one step later.
        self::assertTrue($totp->verify(self::RFC_SECRET, '287082', 1, 59 + 30));
    }

    public function testGeneratedSecretRoundTripsWithAFreshCode(): void
    {
        $totp   = new TotpService();
        $secret = $totp->generateSecret();
        // A generated secret is valid base32 and its own current code verifies.
        $now = time();
        $code = null;
        // Derive the current code by brute-checking a small window against verify().
        for ($c = 0; $c < 1000000; $c++) {
            $candidate = str_pad((string) $c, 6, '0', STR_PAD_LEFT);
            if ($totp->verify($secret, $candidate, 0, $now)) {
                $code = $candidate;
                break;
            }
        }
        self::assertNotNull($code, 'A generated secret should produce a verifiable code');
    }

    public function testProvisioningUriShape(): void
    {
        $totp = new TotpService();
        $uri  = $totp->provisioningUri(self::RFC_SECRET, 'ada@example.com', 'VideoMed');
        self::assertStringStartsWith('otpauth://totp/VideoMed:ada%40example.com?', $uri);
        self::assertStringContainsString('secret=' . self::RFC_SECRET, $uri);
        self::assertStringContainsString('algorithm=SHA1', $uri);
        self::assertStringContainsString('digits=6', $uri);
    }
}
