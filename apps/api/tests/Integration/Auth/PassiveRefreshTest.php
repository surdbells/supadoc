<?php

declare(strict_types=1);

namespace App\Tests\Integration\Auth;

use App\Action\Auth\RefreshAction;
use App\Domain\Enum\AuthErrorCode;
use App\Domain\Exception\AuthenticationException;
use App\Tests\Integration\Auth\Support\AuthHarness;
use Psr\Http\Message\ResponseInterface;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response;

/**
 * A refresh a background poll started (`X-SD-Passive: 1`, document-sharing
 * spec §2.8) against Postgres: the session is checked exactly like any other
 * refresh — an idle one is still refused — but it is not touched, so a tab
 * that only polls lets the server idle timeout fire. Any other refresh still
 * counts as activity (a call or an active user keeps the session alive).
 */
final class PassiveRefreshTest extends AuthIntegrationTestCase
{
    public function testAPassiveRefreshIsCheckedButIsNoActivity(): void
    {
        foreach (['staff' => $this->signInStaff(), 'customer' => $this->signInPatient()] as $scope => $session) {
            $this->age($session['jti'], activeSecondsAgo: 600);

            $this->assertSame(200, $this->refreshVia($session['refresh'], true)->getStatusCode(), $scope);
            $this->assertGreaterThanOrEqual(590, $this->secondsSinceActive($session['jti']), "$scope: a poll's refresh is no activity");

            $this->assertSame(200, $this->refreshVia($session['refresh'], false)->getStatusCode(), $scope);
            $this->assertLessThan(10, $this->secondsSinceActive($session['jti']), "$scope: any other refresh is");
        }
    }

    public function testAPassiveRefreshOfAnIdleSessionIsStillRefused(): void
    {
        foreach (['staff' => $this->signInStaff(), 'customer' => $this->signInPatient()] as $scope => $session) {
            $this->age($session['jti'], activeSecondsAgo: AuthHarness::IDLE + 5);
            try {
                $this->refreshVia($session['refresh'], true);
                $this->fail("$scope: an idle session must not refresh");
            } catch (AuthenticationException $e) {
                $this->assertSame(AuthErrorCode::SESSION_EXPIRED, $e->authCode, $scope);
                $this->assertSame('idle', $e->details['reason'] ?? null, $scope);
            }
        }
    }

    private function refreshVia(string $refreshToken, bool $passive): ResponseInterface
    {
        $request = (new ServerRequestFactory())->createServerRequest('POST', '/api/auth/refresh')
            ->withParsedBody(['refresh_token' => $refreshToken]);
        if ($passive) {
            $request = $request->withHeader('X-SD-Passive', '1');
        }

        return $this->container()->get(RefreshAction::class)($request, new Response());
    }
}
