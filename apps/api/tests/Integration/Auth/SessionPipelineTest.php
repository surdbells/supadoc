<?php

declare(strict_types=1);

namespace App\Tests\Integration\Auth;

use App\Action\Auth\ChangePasswordAction;
use App\Infrastructure\Service\SessionService;
use App\Tests\Integration\Auth\Support\AuthHarness;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response;

/**
 * Authenticated requests through the whole app (global middleware, the route
 * groups' auth + per-user limit) against Postgres and Redis: each 401 path of
 * a session-bound request with its code, the "access token expired → refresh
 * → retry" round trip the portals rely on, activity keeping the idle clock
 * going, and rate limits that never sign anyone out.
 */
final class SessionPipelineTest extends AuthIntegrationTestCase
{
    // ----- Live sessions -----

    public function testLiveSessionsReachTheirPortalAndCountAsActivity(): void
    {
        $staff   = $this->signInStaff();
        $patient = $this->signInPatient();
        $this->age($staff['jti'], activeSecondsAgo: 300);
        $this->age($patient['jti'], activeSecondsAgo: 300);

        $this->assertSame(200, $this->send('GET', '/api/me', $staff['access'])['status']);
        $this->assertSame(200, $this->send('GET', '/api/portal/me', $patient['access'])['status']);

        $this->assertLessThan(10, $this->secondsSinceActive($staff['jti']), 'staff activity recorded');
        $this->assertLessThan(10, $this->secondsSinceActive($patient['jti']), 'patient activity recorded');
    }

    // ----- The access token ran out: refresh and retry -----

    public function testAnExpiredAccessTokenIsTokenExpiredAndARefreshFixesIt(): void
    {
        foreach (['/api/me' => $this->signInStaff(), '/api/portal/me' => $this->signInPatient()] as $path => $session) {
            $scope   = $path === '/api/me' ? 'staff' : 'customer';
            $expired = $this->jwt(accessTtl: -10)->issueAccessToken($session['sub'], $scope, jti: $session['jti']);

            $this->assertAuthError($this->send('GET', $path, $expired), 'token_expired', 'Invalid or expired token');

            $refreshed = $this->send('POST', '/api/auth/refresh', json: ['refresh_token' => $session['refresh']]);
            $this->assertSame(200, $refreshed['status']);
            $this->assertSame(200, $this->send('GET', $path, (string) $refreshed['body']['data']['access_token'])['status'], "$path: the retry works");
        }
    }

    public function testGarbageAndMissingTokens(): void
    {
        foreach (['/api/me', '/api/portal/me'] as $path) {
            $this->assertAuthError($this->send('GET', $path), 'token_missing', 'Missing bearer token');
            $this->assertAuthError($this->send('GET', $path, 'not-a-jwt'), 'token_invalid', 'Invalid or expired token');
        }
        // A refresh token is not a bearer.
        $staff = $this->signInStaff();
        $this->assertAuthError($this->send('GET', '/api/me', $staff['refresh']), 'token_invalid', 'Invalid or expired token');
    }

    public function testAnotherPortalsTokenIsWrongAudience(): void
    {
        $staff   = $this->signInStaff();
        $patient = $this->signInPatient();

        $this->assertAuthError($this->send('GET', '/api/me', $patient['access']), 'token_wrong_audience', 'This token is not valid for staff endpoints');
        $this->assertAuthError($this->send('GET', '/api/portal/me', $staff['access']), 'token_wrong_audience', 'This token is not valid for customer endpoints');
    }

    // ----- The session is over: sign out -----

    public function testASignedOutSessionIsRefusedAtOnceWithItsCode(): void
    {
        foreach (['/api/me' => $this->signInStaff(), '/api/portal/me' => $this->signInPatient()] as $path => $session) {
            $this->assertSame(200, $this->send('POST', '/api/auth/logout', json: ['refresh_token' => $session['refresh']])['status']);

            // The access token still has ~15 minutes, but its session is gone.
            $this->assertAuthError($this->send('GET', $path, $session['access']), 'session_revoked', 'This session has been signed out. Please sign in again.');
        }
    }

    public function testAnIdleSessionIsSessionExpiredIdleOnTheRequestAndTheRefresh(): void
    {
        foreach (['/api/me' => $this->signInStaff(), '/api/portal/me' => $this->signInPatient()] as $path => $session) {
            $this->age($session['jti'], activeSecondsAgo: AuthHarness::IDLE + 5);

            $this->assertAuthError($this->send('GET', $path, $session['access']), 'session_expired', 'Your session has expired. Please sign in again.', 'idle');
            $this->assertAuthError($this->send('POST', '/api/auth/refresh', json: ['refresh_token' => $session['refresh']]), 'session_expired', 'Your session has expired. Please sign in again.', 'idle');
        }
    }

    public function testASessionPastItsLifetimeIsSessionExpiredLifetime(): void
    {
        foreach (['/api/me' => $this->signInStaff(), '/api/portal/me' => $this->signInPatient()] as $path => $session) {
            $this->age($session['jti'], createdSecondsAgo: AuthHarness::ABSOLUTE + 5, activeSecondsAgo: 60);

            $this->assertAuthError($this->send('GET', $path, $session['access']), 'session_expired', 'Your session has expired. Please sign in again.', 'lifetime');
        }
    }

    public function testATokenWithoutALiveSessionIsSessionInvalid(): void
    {
        $staff   = $this->signInStaff();
        $patient = $this->signInPatient();

        foreach ([
            ['/api/me', $this->jwt()->issueAccessToken($staff['sub'], 'staff', ['admin'])],
            ['/api/me', $this->jwt()->issueAccessToken($staff['sub'], 'staff', ['admin'], [], bin2hex(random_bytes(16)))],
            ['/api/portal/me', $this->jwt()->issueAccessToken($patient['sub'], 'customer')],
            ['/api/portal/me', $this->jwt()->issueAccessToken($patient['sub'], 'customer', jti: $staff['jti'])],
        ] as [$path, $token]) {
            $this->assertAuthError($this->send('GET', $path, $token), 'session_invalid', 'Your session is no longer valid. Please sign in again.');
        }
    }

    public function testAnAdminDeactivationEndsTheSessionAndTheRefreshSaysWhy(): void
    {
        $user    = $this->staffUser();
        $session = $this->signInStaff($user);
        $this->container()->get(SessionService::class)->revokeAllStaff($user->getId());
        $this->conn()->executeStatement('UPDATE users SET active = false WHERE id = ?', [$user->getId()]);

        $this->assertAuthError($this->send('GET', '/api/me', $session['access']), 'session_revoked', 'This session has been signed out. Please sign in again.');
        $this->assertAuthError(
            $this->send('POST', '/api/auth/refresh', json: ['refresh_token' => $session['refresh']]),
            'account_deactivated',
            'This account has been deactivated. Please contact your administrator.',
        );
    }

    public function testAStaffAccountMissingBehindALiveTokenIsAccountMissing(): void
    {
        // Defensive path of the action (the middleware normally refuses first).
        $action  = $this->container()->get(ChangePasswordAction::class);
        $request = (new ServerRequestFactory())->createServerRequest('POST', '/api/me/password')
            ->withAttribute('user_id', '00000000-0000-4000-8000-000000000000')
            ->withParsedBody(['current_password' => 'x', 'new_password' => 'long-enough-password']);
        $res  = $action($request, new Response());
        $body = json_decode((string) $res->getBody(), true);

        $this->assertSame(401, $res->getStatusCode());
        $this->assertSame(['auth' => 'Not authenticated', 'code' => 'account_missing'], $body['errors']);
    }

    public function testAnExpiredPhoneProofIsA422ForASignedInPatient(): void
    {
        $patient = $this->signInPatient();
        $proof   = $this->jwt()->issuePhoneProof('+2348000000001', -10);

        $res = $this->send('POST', '/api/portal/me/verify-phone', $patient['access'], ['verification_token' => $proof]);

        $this->assertSame(422, $res['status']);
        $this->assertSame('phone_proof_expired', $res['body']['errors']['code']);
        $this->assertSame(200, $this->send('GET', '/api/portal/me', $patient['access'])['status'], 'still signed in');
    }

    // ----- Rate limits (Redis) never sign anyone out -----

    public function testThePerUserLimitCountsUserByUserBehindOneAddress(): void
    {
        $this->requireRedis();
        // A long window, so the three requests never straddle a window boundary.
        AuthHarness::set(['RATE_LIMIT_USER_REQUESTS' => '2', 'RATE_LIMIT_WINDOW' => '3600']);
        $ada     = $this->signInStaff();
        $bola    = $this->signInStaff();
        $patient = $this->signInPatient();

        $this->assertSame(200, $this->send('GET', '/api/me', $ada['access'])['status']);
        $this->assertSame(200, $this->send('GET', '/api/me', $ada['access'])['status']);
        $limited = $this->send('GET', '/api/me', $ada['access']);
        $this->assertSame(429, $limited['status']);
        $this->assertSame('rate_limited', $limited['body']['errors']['code']);
        $this->assertSame('Too many requests', $limited['body']['message']);
        $retry = (int) $limited['response']->getHeaderLine('Retry-After');
        $this->assertTrue($retry >= 1 && $retry <= 3600, 'Retry-After within the window');

        $this->assertSame(200, $this->send('GET', '/api/me', $bola['access'])['status'], 'a colleague on the same IP is unaffected');
        $this->assertSame(200, $this->send('GET', '/api/portal/me', $patient['access'])['status'], 'and so is a patient');
        $this->assertFalse($this->isRevoked($ada['jti']), 'a 429 never ends a session');
    }

    public function testARateLimitedRefreshIsTransient(): void
    {
        $this->requireRedis();
        AuthHarness::set(['RATE_LIMIT_AUTH_REQUESTS' => '1', 'RATE_LIMIT_WINDOW' => '3600']);
        $session = $this->signInPatient();

        $this->assertSame(200, $this->send('POST', '/api/auth/refresh', json: ['refresh_token' => $session['refresh']])['status']);
        $limited = $this->send('POST', '/api/auth/refresh', json: ['refresh_token' => $session['refresh']]);
        $this->assertSame(429, $limited['status']);
        $this->assertSame('rate_limited', $limited['body']['errors']['code']);

        $this->assertFalse($this->isRevoked($session['jti']));
        $this->assertSame(200, $this->send('GET', '/api/portal/me', $session['access'])['status'], 'the session carries on');
    }

    private function requireRedis(): void
    {
        $reason = AuthHarness::redisUnavailableReason();
        if ($reason !== null) {
            $this->markTestSkipped($reason);
        }
    }
}
