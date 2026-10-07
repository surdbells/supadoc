<?php

declare(strict_types=1);

namespace App\Domain\Entity;

use DateTimeImmutable;
use Doctrine\ORM\Mapping as ORM;

/**
 * Consecutive failed prescription checks for one device (or one IP), and the
 * lock that follows too many (GVM-RX-02 AC34). Keyed by a hash, so no raw
 * device id or IP is stored here. A matching check resets the device's run.
 */
#[ORM\Entity]
#[ORM\Table(name: 'prescription_check_throttles')]
class PrescriptionCheckThrottle
{
    #[ORM\Id]
    #[ORM\Column(name: 'key_hash', type: 'string', length: 64)]
    private string $keyHash;

    #[ORM\Column(type: 'integer')]
    private int $failures = 0;

    #[ORM\Column(name: 'locked_until', type: 'datetime_immutable', nullable: true)]
    private ?DateTimeImmutable $lockedUntil = null;

    #[ORM\Column(name: 'updated_at', type: 'datetime_immutable')]
    private DateTimeImmutable $updatedAt;

    public function __construct(string $keyHash)
    {
        $this->keyHash   = $keyHash;
        $this->updatedAt = new DateTimeImmutable();
    }

    public function lockedUntil(DateTimeImmutable $now): ?DateTimeImmutable
    {
        return $this->lockedUntil !== null && $this->lockedUntil > $now ? $this->lockedUntil : null;
    }

    /** Count a miss; lock for `$lockMinutes` once `$maxFailures` misses run together. */
    public function fail(DateTimeImmutable $now, int $maxFailures, int $lockMinutes): void
    {
        // A lock that has run out starts a fresh run.
        if ($this->lockedUntil !== null && $this->lockedUntil <= $now) {
            $this->lockedUntil = null;
            $this->failures    = 0;
        }
        ++$this->failures;
        if ($this->failures >= $maxFailures) {
            $this->lockedUntil = $now->modify("+{$lockMinutes} minutes");
        }
        $this->updatedAt = $now;
    }

    public function reset(DateTimeImmutable $now): void
    {
        $this->failures    = 0;
        $this->lockedUntil = null;
        $this->updatedAt   = $now;
    }

    public function getFailures(): int
    {
        return $this->failures;
    }
}
