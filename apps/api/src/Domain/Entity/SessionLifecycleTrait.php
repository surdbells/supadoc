<?php

declare(strict_types=1);

namespace App\Domain\Entity;

use DateTimeImmutable;
use Doctrine\ORM\Mapping as ORM;

/**
 * Activity + revocation state shared by patient and staff sessions. A session
 * is live only while it is not revoked, has seen activity within the idle
 * window, and is younger than the absolute lifetime — so a token stolen from a
 * closed browser stops working on its own, server-side, whatever the client
 * does. Requires the host entity to also use {@see TimestampsTrait}.
 */
trait SessionLifecycleTrait
{
    /** Activity writes are throttled to one per this many seconds per session. */
    private const TOUCH_INTERVAL = 60;

    #[ORM\Column(name: 'last_active_at', type: 'datetime_immutable', nullable: true)]
    private ?DateTimeImmutable $lastActiveAt = null;

    #[ORM\Column(name: 'revoked_at', type: 'datetime_immutable', nullable: true)]
    private ?DateTimeImmutable $revokedAt = null;

    public function isRevoked(): bool
    {
        return $this->revokedAt !== null;
    }

    public function revoke(): void
    {
        $this->revokedAt ??= new DateTimeImmutable();
    }

    /** When the session last saw an authenticated request (falls back to sign-in time). */
    public function getLastActiveAt(): DateTimeImmutable
    {
        return $this->lastActiveAt ?? $this->createdAt;
    }

    /**
     * Whether the session has run out — idle for longer than `$idleSeconds`, or
     * older than `$absoluteSeconds`. A non-positive limit disables that check.
     */
    public function isExpired(DateTimeImmutable $now, int $idleSeconds, int $absoluteSeconds): bool
    {
        $nowTs = $now->getTimestamp();
        if ($idleSeconds > 0 && $nowTs - $this->getLastActiveAt()->getTimestamp() > $idleSeconds) {
            return true;
        }

        return $absoluteSeconds > 0 && $nowTs - $this->createdAt->getTimestamp() > $absoluteSeconds;
    }

    /**
     * Record activity at `$now`. Returns true when the stored timestamp changed
     * (the caller should persist), false when throttled — so an active user
     * costs at most one write per minute rather than one per request.
     */
    public function markActive(DateTimeImmutable $now): bool
    {
        $last = $this->lastActiveAt;
        if ($last !== null && $now->getTimestamp() - $last->getTimestamp() < self::TOUCH_INTERVAL) {
            return false;
        }
        $this->lastActiveAt = $now;

        return true;
    }
}
