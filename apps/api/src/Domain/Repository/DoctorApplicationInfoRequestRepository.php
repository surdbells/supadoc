<?php

declare(strict_types=1);

namespace App\Domain\Repository;

use App\Domain\Entity\DoctorApplicationInfoRequest;
use Doctrine\ORM\Query;

final class DoctorApplicationInfoRequestRepository extends BaseRepository
{
    protected function getEntityClass(): string
    {
        return DoctorApplicationInfoRequest::class;
    }

    /** @return list<DoctorApplicationInfoRequest> newest first */
    public function forApplication(string $applicationId): array
    {
        return $this->forApplicationQuery($applicationId)->getResult();
    }

    public function forApplicationQuery(string $applicationId): Query
    {
        return $this->qb()
            ->andWhere('e.applicationId = :app')
            ->setParameter('app', $applicationId)
            ->orderBy('e.requestedAt', 'DESC')
            ->addOrderBy('e.id', 'DESC')
            ->getQuery();
    }

    /** The one request still waiting for the applicant (not answered, not closed), or null. */
    public function openFor(string $applicationId): ?DoctorApplicationInfoRequest
    {
        return $this->openForQuery($applicationId)->getOneOrNullResult();
    }

    public function openForQuery(string $applicationId): Query
    {
        return $this->qb()
            ->andWhere('e.applicationId = :app')
            ->andWhere('e.respondedAt IS NULL')
            ->andWhere('e.closedAt IS NULL')
            ->setParameter('app', $applicationId)
            ->orderBy('e.requestedAt', 'DESC')
            ->setMaxResults(1)
            ->getQuery();
    }
}
