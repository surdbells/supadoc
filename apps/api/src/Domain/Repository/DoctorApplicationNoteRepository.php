<?php

declare(strict_types=1);

namespace App\Domain\Repository;

use App\Domain\Entity\DoctorApplicationNote;
use Doctrine\ORM\Query;

/** Staff-only notes — never joined into anything the applicant reads. */
final class DoctorApplicationNoteRepository extends BaseRepository
{
    protected function getEntityClass(): string
    {
        return DoctorApplicationNote::class;
    }

    /** @return list<DoctorApplicationNote> newest first */
    public function forApplication(string $applicationId): array
    {
        return $this->forApplicationQuery($applicationId)->getResult();
    }

    public function forApplicationQuery(string $applicationId): Query
    {
        return $this->qb()
            ->andWhere('e.applicationId = :app')
            ->setParameter('app', $applicationId)
            ->orderBy('e.createdAt', 'DESC')
            ->addOrderBy('e.id', 'DESC')
            ->setMaxResults(500)
            ->getQuery();
    }

    public function countFor(string $applicationId): int
    {
        return (int) $this->em->createQueryBuilder()
            ->select('COUNT(e.id)')
            ->from(DoctorApplicationNote::class, 'e')
            ->andWhere('e.applicationId = :app')
            ->setParameter('app', $applicationId)
            ->getQuery()
            ->getSingleScalarResult();
    }
}
