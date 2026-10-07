<?php

declare(strict_types=1);

namespace App\Domain\Repository;

use App\Domain\Entity\PrescriptionCheckThrottle;
use DateTimeImmutable;

/**
 * Atomic counters behind the pharmacist-check lock-out. Every operation is a
 * single SQL statement (UPSERT … RETURNING / UPDATE), so parallel requests can
 * never lose an increment or slip past a lock the way a read-modify-write
 * through the ORM could.
 */
final class PrescriptionCheckThrottleRepository extends BaseRepository
{
    private const TS = 'Y-m-d H:i:s';

    protected function getEntityClass(): string
    {
        return PrescriptionCheckThrottle::class;
    }

    /**
     * Count one attempt against `$key` and return the running count plus any
     * active lock. The count restarts when the previous attempt is older than
     * `$windowMinutes`, or when an earlier lock has run out.
     *
     * @return array{failures: int, locked_until: ?DateTimeImmutable}
     */
    public function charge(string $key, int $windowMinutes, DateTimeImmutable $now): array
    {
        $row = $this->em->getConnection()->fetchAssociative(
            'INSERT INTO prescription_check_throttles AS t (key_hash, failures, locked_until, updated_at)
             VALUES (:key, 1, NULL, :now)
             ON CONFLICT (key_hash) DO UPDATE SET
               failures = CASE
                 WHEN t.updated_at < :window_start OR (t.locked_until IS NOT NULL AND t.locked_until <= :now) THEN 1
                 ELSE t.failures + 1
               END,
               locked_until = CASE WHEN t.locked_until IS NOT NULL AND t.locked_until <= :now THEN NULL ELSE t.locked_until END,
               updated_at = :now
             RETURNING failures, locked_until',
            [
                'key'          => $key,
                'now'          => $now->format(self::TS),
                'window_start' => $now->modify("-{$windowMinutes} minutes")->format(self::TS),
            ],
        );

        return [
            'failures'     => (int) ($row['failures'] ?? 1),
            'locked_until' => ($row['locked_until'] ?? null) !== null ? new DateTimeImmutable((string) $row['locked_until']) : null,
        ];
    }

    /** Lock `$key` until `$until` (never shortening an existing lock). */
    public function lock(string $key, DateTimeImmutable $until): void
    {
        $this->em->getConnection()->executeStatement(
            'UPDATE prescription_check_throttles
                SET locked_until = CASE WHEN locked_until IS NULL OR locked_until < :until THEN :until ELSE locked_until END
              WHERE key_hash = :key',
            ['key' => $key, 'until' => $until->format(self::TS)],
        );
    }

    /** Give back one counted attempt (a check that matched is not a miss). */
    public function refund(string $key): void
    {
        $this->em->getConnection()->executeStatement(
            'UPDATE prescription_check_throttles SET failures = GREATEST(failures - 1, 0) WHERE key_hash = :key',
            ['key' => $key],
        );
    }

    /** Forget a key's run of misses (and any lock). */
    public function reset(string $key): void
    {
        $this->em->getConnection()->executeStatement(
            'DELETE FROM prescription_check_throttles WHERE key_hash = :key',
            ['key' => $key],
        );
    }
}
