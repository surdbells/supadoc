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

    public function testEveryDeadStateExplainsItself(): void
    {
        foreach ([SessionState::EXPIRED, SessionState::REVOKED, SessionState::UNKNOWN] as $state) {
            $this->assertStringContainsString('sign in again', $state->message());
        }
        $this->assertSame('', SessionState::ACTIVE->message());
    }
}
