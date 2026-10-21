<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Domain\Entity\SessionLifecycleTrait;
use App\Domain\Entity\TimestampsTrait;
use App\Domain\Enum\SessionState;
use DateTimeImmutable;
use PHPUnit\Framework\TestCase;

/** Idle / absolute expiry and activity throttling shared by patient + staff sessions. */
final class SessionLifecycleTest extends TestCase
{
    private const IDLE     = 3600;
    private const ABSOLUTE = 43200;

    private function session(): object
    {
        $s = new class {
            use TimestampsTrait;
            use SessionLifecycleTrait;
        };
        $s->initTimestamps();

        return $s;
    }

    private function at(object $s, int $seconds): DateTimeImmutable
    {
        return $s->getCreatedAt()->modify("+{$seconds} seconds");
    }

    public function testFreshSessionIsLive(): void
    {
        $s = $this->session();
        $this->assertFalse($s->isRevoked());
        $this->assertFalse($s->isExpired($this->at($s, 60), self::IDLE, self::ABSOLUTE));
    }

    public function testIdleSessionExpires(): void
    {
        $s = $this->session();
        $this->assertTrue($s->isExpired($this->at($s, self::IDLE + 1), self::IDLE, self::ABSOLUTE));
    }

    public function testActivityResetsTheIdleClock(): void
    {
        $s = $this->session();
        $this->assertTrue($s->markActive($this->at($s, 3000)));
        // 3000s after sign-in + almost a full idle window — still live.
        $this->assertFalse($s->isExpired($this->at($s, 3000 + self::IDLE - 1), self::IDLE, self::ABSOLUTE));
        $this->assertTrue($s->isExpired($this->at($s, 3000 + self::IDLE + 1), self::IDLE, self::ABSOLUTE));
    }

    public function testActivityWritesAreThrottled(): void
    {
        $s = $this->session();
        $this->assertTrue($s->markActive($this->at($s, 100)));
        $this->assertFalse($s->markActive($this->at($s, 130)));   // < 60s later: no write
        $this->assertTrue($s->markActive($this->at($s, 161)));
    }

    public function testAbsoluteLifetimeWinsOverActivity(): void
    {
        $s = $this->session();
        $s->markActive($this->at($s, self::ABSOLUTE - 60));
        $this->assertTrue($s->isExpired($this->at($s, self::ABSOLUTE + 1), self::IDLE, self::ABSOLUTE));
    }

    public function testRevocationIsSticky(): void
    {
        $s = $this->session();
        $s->revoke();
        $this->assertTrue($s->isRevoked());
    }

    public function testExpiryReasonNamesTheLimitThatRanOut(): void
    {
        $s = $this->session();
        $this->assertNull($s->expiryReason($this->at($s, self::IDLE), self::IDLE, self::ABSOLUTE), 'exactly the idle window: still live');
        $this->assertSame(SessionState::REASON_IDLE, $s->expiryReason($this->at($s, self::IDLE + 1), self::IDLE, self::ABSOLUTE));

        // Kept active up to the end: the absolute lifetime is what ends it.
        $s->markActive($this->at($s, self::ABSOLUTE - 60));
        $this->assertNull($s->expiryReason($this->at($s, self::ABSOLUTE), self::IDLE, self::ABSOLUTE));
        $this->assertSame(SessionState::REASON_LIFETIME, $s->expiryReason($this->at($s, self::ABSOLUTE + 1), self::IDLE, self::ABSOLUTE));
    }

    public function testWhenBothLimitsPassedTheFirstOneCrossedIsTheReason(): void
    {
        // Idle since 1000s: the idle limit passed at 4600s, long before the 43200s lifetime.
        $idleFirst = $this->session();
        $idleFirst->markActive($this->at($idleFirst, 1000));
        $this->assertSame(SessionState::REASON_IDLE, $idleFirst->expiryReason($this->at($idleFirst, self::ABSOLUTE + 500), self::IDLE, self::ABSOLUTE));

        // Active until just before the lifetime ended: the lifetime ran out first.
        $lifeFirst = $this->session();
        $lifeFirst->markActive($this->at($lifeFirst, self::ABSOLUTE - 10));
        $this->assertSame(SessionState::REASON_LIFETIME, $lifeFirst->expiryReason($this->at($lifeFirst, self::ABSOLUTE + self::IDLE), self::IDLE, self::ABSOLUTE));

        // A tie counts as the lifetime.
        $tie = $this->session();
        $tie->markActive($this->at($tie, self::ABSOLUTE - self::IDLE));
        $this->assertSame(SessionState::REASON_LIFETIME, $tie->expiryReason($this->at($tie, self::ABSOLUTE + 1), self::IDLE, self::ABSOLUTE));
    }

    public function testANonPositiveLimitIsSwitchedOff(): void
    {
        $s = $this->session();
        $this->assertNull($s->expiryReason($this->at($s, 10 * self::ABSOLUTE), 0, 0));
        $this->assertSame(SessionState::REASON_LIFETIME, $s->expiryReason($this->at($s, self::ABSOLUTE + 1), 0, self::ABSOLUTE));
        $this->assertFalse($s->isExpired($this->at($s, 10 * self::ABSOLUTE), -1, 0));
    }

    public function testEveryDeadStateExplainsItself(): void
    {
        foreach ([SessionState::EXPIRED, SessionState::REVOKED, SessionState::UNKNOWN] as $state) {
            $this->assertStringContainsString('sign in again', $state->message());
        }
        $this->assertSame('', SessionState::ACTIVE->message());
    }
}
