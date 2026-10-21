<?php

declare(strict_types=1);

namespace App\Tests\Integration\Auth;

use App\Domain\Enum\AuthErrorCode;
use App\Domain\Enum\SessionState;
use App\Domain\Exception\AuthenticationException;
use App\Infrastructure\Service\JwtService;
use App\Infrastructure\Service\SessionService;
use App\Tests\Integration\Auth\Support\AuthHarness;

/**
 * POST /api/auth/refresh against Postgres: every refusal names why (a code that
 * always means "sign out"), the idle / absolute boundaries hold to the second,
 * a refresh never revives a revoked or run-out session, a deactivated account
 * hears that it was deactivated, and the messages are the ones the portals
 * already show.
 */
final class RefreshCodesTest extends AuthIntegrationTestCase
{
    private const EXPIRED = 'Your session has expired. Please sign in again.';
    private const REVOKED = 'This session has been signed out. Please sign in again.';
    private const UNKNOWN = 'Your session is no longer valid. Please sign in again.';

    // ----- A live session refreshes -----

    public function testALiveSessionRefreshesKeepsItsJtiAndIsTouched(): void
    {
        foreach (['staff' => $this->signInStaff(), 'customer' => $this->signInPatient()] as $scope => $session) {
            $this->age($session['jti'], activeSecondsAgo: 600);

            $res = $this->send('POST', '/api/auth/refresh', json: ['refresh_token' => $session['refresh']]);

            $this->assertSame(200, $res['status'], $scope);
            $this->assertSame(AuthHarness::ACCESS, $res['body']['data']['expires_in']);
            $this->assertArrayNotHasKey('refresh_token', $res['body']['data'], 'the refresh token is not rotated');
            $claims = $this->jwt()->validateAccessToken((string) $res['body']['data']['access_token']);
            $this->assertSame($session['jti'], $claims->jti, 'the same session');
            $this->assertSame($scope, $claims->scope);
            $this->assertLessThan(10, $this->secondsSinceActive($session['jti']), 'a refresh counts as activity');
        }
    }

    // ----- The idle and absolute limits, to the second -----

    public function testTheIdleWindowIsTheLastSecondARefreshWorks(): void
    {
        foreach (['staff' => [$this->signInStaff(), $this->signInStaff()], 'customer' => [$this->signInPatient(), $this->signInPatient()]] as $scope => [$inside, $past]) {
            $this->age($inside['jti'], activeSecondsAgo: AuthHarness::IDLE - 30);
            $this->age($past['jti'], activeSecondsAgo: AuthHarness::IDLE + 5);

            $this->assertSame(200, $this->refresh($inside['refresh'])['status'], "$scope: 30 s inside the idle window");
            $this->assertAuthError($this->refresh($past['refresh']), 'session_expired', self::EXPIRED, 'idle');
            $this->assertAuthError($this->refresh($past['refresh']), 'session_expired', self::EXPIRED, 'idle');
            $this->assertGreaterThan(AuthHarness::IDLE, $this->secondsSinceActive($past['jti']), "$scope: a refused refresh is no activity — the session stays dead");
        }
    }

    public function testTheAbsoluteLifetimeEndsTheSessionHoweverActive(): void
    {
        foreach (['staff' => [$this->signInStaff(), $this->signInStaff()], 'customer' => [$this->signInPatient(), $this->signInPatient()]] as $scope => [$inside, $past]) {
            $this->age($inside['jti'], createdSecondsAgo: AuthHarness::ABSOLUTE - 30, activeSecondsAgo: 120);
            $this->age($past['jti'], createdSecondsAgo: AuthHarness::ABSOLUTE + 5, activeSecondsAgo: 120);

            $this->assertSame(200, $this->refresh($inside['refresh'])['status'], "$scope: 30 s before the 12 h mark");
            $this->assertAuthError($this->refresh($past['refresh']), 'session_expired', self::EXPIRED, 'lifetime');
        }
    }

    public function testAnExpiredRefreshTokenIsTheEndOfTheLifetime(): void
    {
        $staff   = $this->signInStaff();
        $patient = $this->signInPatient();
        $expired = $this->jwt(refreshTtl: -10);

        $this->assertAuthError($this->refresh($expired->issueRefreshToken($staff['sub'], 'staff', $staff['jti'])), 'session_expired', self::EXPIRED, 'lifetime');
        $this->assertAuthError($this->refresh($expired->issueRefreshToken($patient['sub'], 'customer', $patient['jti'])), 'session_expired', self::EXPIRED, 'lifetime');
    }

    // ----- Bad refresh tokens -----

    public function testAnUnusableRefreshTokenIsRefreshInvalid(): void
    {
        $staff   = $this->signInStaff();
        $foreign = new JwtService('another-secret-that-is-at-least-32-bytes-long!', 900, 43200);

        foreach ([
            'garbage'         => 'garbage',
            'foreign signer'  => $foreign->issueRefreshToken($staff['sub'], 'staff', $staff['jti']),
            'an access token' => $staff['access'],
            'unknown scope'   => $this->jwt()->issueRefreshToken($staff['sub'], 'investor', $staff['jti']),
            'no scope'        => \Firebase\JWT\JWT::encode(['sub' => $staff['sub'], 'type' => 'refresh', 'jti' => $staff['jti'], 'iat' => time(), 'exp' => time() + 60], (string) $_ENV['JWT_SECRET'], 'HS256'),
        ] as $case => $token) {
            $res = $this->refresh($token);
            $this->assertAuthError($res, 'refresh_invalid', $case === 'unknown scope' || $case === 'no scope' ? self::UNKNOWN : self::EXPIRED);
        }
        $this->assertFalse($this->isRevoked($staff['jti']), 'nothing was signed out by a bad token');
    }

    public function testARefreshTokenWithoutALiveSessionIsSessionInvalid(): void
    {
        $staff   = $this->signInStaff();
        $patient = $this->signInPatient();

        foreach ([
            'staff, no jti'       => $this->jwt()->issueRefreshToken($staff['sub'], 'staff'),
            'patient, no jti'     => $this->jwt()->issueRefreshToken($patient['sub'], 'customer'), // fails closed now
            'staff, unknown jti'  => $this->jwt()->issueRefreshToken($staff['sub'], 'staff', bin2hex(random_bytes(16))),
            'patient, staff jti'  => $this->jwt()->issueRefreshToken($patient['sub'], 'customer', $staff['jti']),
        ] as $case => $token) {
            $this->assertAuthError($this->refresh($token), 'session_invalid', self::UNKNOWN);
        }
    }

    // ----- Signed out -----

    public function testAfterSignOutTheRefreshIsSessionRevoked(): void
    {
        foreach ([$this->signInStaff(), $this->signInPatient()] as $session) {
            $this->assertSame(200, $this->send('POST', '/api/auth/logout', json: ['refresh_token' => $session['refresh']])['status']);
            $this->assertSame(200, $this->send('POST', '/api/auth/logout', json: ['refresh_token' => $session['refresh']])['status'], 'idempotent');

            $this->assertAuthError($this->refresh($session['refresh']), 'session_revoked', self::REVOKED);
        }
    }

    // ----- The account behind the session -----

    public function testADeactivatedStaffAccountHearsWhyAndLosesTheSession(): void
    {
        $user    = $this->staffUser();
        $session = $this->signInStaff($user);
        $this->conn()->executeStatement('UPDATE users SET active = false WHERE id = ?', [$user->getId()]);

        $this->assertAuthError($this->refresh($session['refresh']), 'account_deactivated', 'This account has been deactivated. Please contact your administrator.');
        $this->assertTrue($this->isRevoked($session['jti']), 'the session is revoked at the refresh');
        $this->assertAuthError($this->refresh($session['refresh']), 'account_deactivated', 'This account has been deactivated. Please contact your administrator.');
    }

    public function testDeactivationByAnAdminSaysDeactivatedNotSignedOut(): void
    {
        // The admin path revokes every session first; the account is still checked first.
        $user    = $this->staffUser();
        $session = $this->signInStaff($user);
        $this->container()->get(SessionService::class)->revokeAllStaff($user->getId());
        $this->conn()->executeStatement('UPDATE users SET active = false WHERE id = ?', [$user->getId()]);

        $this->assertAuthError($this->refresh($session['refresh']), 'account_deactivated', 'This account has been deactivated. Please contact your administrator.');
    }

    public function testAMissingAccountIsAccountMissing(): void
    {
        $staff   = $this->signInStaff();
        $patient = $this->signInPatient();
        $ghost   = '00000000-0000-4000-8000-000000000000';

        $this->assertAuthError($this->refresh($this->jwt()->issueRefreshToken($ghost, 'staff', $staff['jti'])), 'account_missing', 'Account no longer exists');
        $this->assertAuthError($this->refresh($this->jwt()->issueRefreshToken($ghost, 'customer', $patient['jti'])), 'account_missing', 'Account no longer exists');
    }

    // ----- The service speaks the same codes -----

    public function testTheServiceThrowsTheCodes(): void
    {
        $session = $this->signInPatient();
        $this->auth()->logout($session['refresh']);

        try {
            $this->auth()->refresh($session['refresh']);
            $this->fail('a signed-out session does not refresh');
        } catch (AuthenticationException $e) {
            $this->assertSame(AuthErrorCode::SESSION_REVOKED, $e->authCode);
            $this->assertSame(SessionState::REVOKED->message(), $e->getMessage());
            $this->assertTrue($e->authCode->endsSession());
        }
    }

    public function testAMissingRefreshTokenIsStillA422(): void
    {
        $res = $this->send('POST', '/api/auth/refresh', json: []);

        $this->assertSame(422, $res['status']);
        $this->assertSame('Refresh token is required', $res['body']['errors']['refresh_token']);
    }

    /** @return array{status:int, body:array<string,mixed>} */
    private function refresh(string $refreshToken): array
    {
        return $this->send('POST', '/api/auth/refresh', json: ['refresh_token' => $refreshToken]);
    }
}
