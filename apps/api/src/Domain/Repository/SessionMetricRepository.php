<?php

declare(strict_types=1);

namespace App\Domain\Repository;

use App\Domain\Entity\SessionMetric;

final class SessionMetricRepository extends BaseRepository
{
    protected function getEntityClass(): string
    {
        return SessionMetric::class;
    }

    /**
     * The most recent quality samples across the platform, newest first — the
     * monitoring quality view reduces these to the latest per consultation/role.
     *
     * @return list<SessionMetric>
     */
    public function recent(int $limit = 400): array
    {
        return $this->qb()
            ->orderBy('e.createdAt', 'DESC')
            ->setMaxResults($limit)
            ->getQuery()
            ->getResult();
    }

    /** Average round-trip time (ms) over the most recent samples, or null. */
    public function averageRtt(int $sample = 400): ?int
    {
        $avg = $this->em->createQueryBuilder()
            ->select('AVG(e.rtt)')
            ->from(SessionMetric::class, 'e')
            ->andWhere('e.rtt IS NOT NULL')
            ->getQuery()
            ->getSingleScalarResult();

        return $avg !== null ? (int) round((float) $avg) : null;
    }
}
