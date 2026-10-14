<?php

declare(strict_types=1);

namespace App\Domain\Repository;

use App\Domain\Entity\VitalReading;
use Doctrine\ORM\QueryBuilder;

final class VitalReadingRepository extends BaseRepository
{
    protected function getEntityClass(): string
    {
        return VitalReading::class;
    }

    /**
     * A patient's readings, newest taken first — optionally of one type.
     *
     * @return list<VitalReading>
     */
    public function history(string $patientId, ?string $key, int $limit): array
    {
        return $this->historyQuery($patientId, $key)
            ->setMaxResults(max(1, $limit))
            ->getQuery()
            ->getResult();
    }

    /** The history query on its own (unit-tested offline: it must compile to SQL). */
    public function historyQuery(string $patientId, ?string $key): QueryBuilder
    {
        $qb = $this->qb()
            ->andWhere('e.patientId = :patient')
            ->setParameter('patient', $patientId);
        if ($key !== null) {
            $qb->andWhere('e.key = :key')->setParameter('key', $key);
        }

        return $qb->orderBy('e.takenAt', 'DESC')->addOrderBy('e.createdAt', 'DESC');
    }
}
