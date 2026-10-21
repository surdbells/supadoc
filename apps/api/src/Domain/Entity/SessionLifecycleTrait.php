<?php

declare(strict_types=1);

namespace App\Domain\Entity;

use App\Domain\Enum\SessionState;
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
        return $this->expiryReason($now, $idleSeconds, $absoluteSeconds) !== null;
    }

    /**
     * Why the session has run out at `$now`: 'idle' (no activity for longer than
     * `$idleSeconds`) or 'lifetime' (older than `$absoluteSeconds`), whichever
     * limit was crossed first (a tie counts as 'lifetime'); null while it is
     * still within both. A non-positive limit disables that check.
     */
    public function expiryReason(DateTimeImmutable $now, int $idleSeconds, int $absoluteSeconds): ?string
    {
        $nowTs  = $now->getTimestamp();
        $idleAt = $idleSeconds > 0 ? $this->getLastActiveAt()->getTimestamp() + $idleSeconds : null;
        $lifeAt = $absoluteSeconds > 0 ? $this->createdAt->getTimestamp() + $absoluteSeconds : null;
        $idle   = $idleAt !== null && $nowTs > $idleAt;
        $life   = $lifeAt !== null && $nowTs > $lifeAt;

        if ($idle && (!$life || $idleAt < $lifeAt)) {
            return SessionState::REASON_IDLE;
        }

        return $life ? SessionState::REASON_LIFETIME : null;
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
