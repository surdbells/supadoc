<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Infrastructure\Agora\RtcTokenBuilder2;
use PHPUnit\Framework\TestCase;

/**
 * The token can only be *accepted* by Agora's servers, but its structure is
 * fully checkable offline: version prefix "007", a deflate+base64 body, and the
 * app id + channel packed inside. Guards against a broken packing change.
 */
final class AgoraTokenTest extends TestCase
{
    private const APP_ID = '0123456789abcdef0123456789abcdef'; // 32-char hex
    private const CERT   = 'fedcba9876543210fedcba9876543210';

    public function testBuildsAStructurallyValidToken(): void
    {
        $token = RtcTokenBuilder2::buildTokenWithUid(
            self::APP_ID,
            self::CERT,
            'appt-channel',
            0,
            RtcTokenBuilder2::ROLE_PUBLISHER,
            3600,
            3600,
        );

        $this->assertStringStartsWith('007', $token);

        $decoded = zlib_decode((string) base64_decode(substr($token, 3), true));
        $this->assertIsString($decoded);
        $this->assertStringContainsString(self::APP_ID, $decoded);
        $this->assertStringContainsString('appt-channel', $decoded);
    }

    public function testInvalidCredentialsProduceAnEmptyToken(): void
    {
        // build() returns '' unless both are 32-char hex — AgoraTokenService
        // turns this into a 500-safe RuntimeException.
        $token = RtcTokenBuilder2::buildTokenWithUid(
            'not-hex',
            self::CERT,
            'c',
            0,
            RtcTokenBuilder2::ROLE_PUBLISHER,
            3600,
            3600,
        );

        $this->assertSame('', $token);
    }
}
