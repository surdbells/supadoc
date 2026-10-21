<?php

declare(strict_types=1);

namespace App\Domain\Repository;

use App\Domain\Entity\SpecialistStatusEvent;
use Doctrine\ORM\Query;

final class SpecialistStatusEventRepository extends BaseRepository
{
    protected function getEntityClass(): string
    {
        return SpecialistStatusEvent::class;
    }

    /**
     * A doctor's standing history, newest first.
     *
     * @return list<SpecialistStatusEvent>
     */
    public function forSpecialist(string $specialistId, int $limit = 200): array
    {
        return $this->forSpecialistQuery($specialistId, $limit)->getResult();
    }

    /**
     * When the doctor last stopped being approved (the latest status event
     * whose new status is not `approved` — suspended, sent back, …), or null
     * when there is no such event. Document sharing measures a pause from it
     * ({@see \App\Infrastructure\Document\DocumentSharingService::doctorReinstated()}).
     */
    public function lastLeftApprovedAt(string $specialistId): ?\DateTimeImmutable
    {
        $at = $this->lastLeftApprovedAtQuery($specialistId)->getOneOrNullResult(Query::HYDRATE_SINGLE_SCALAR);
        if ($at === null || $at === false || $at === '') {
            return null;
        }

        return $at instanceof \DateTimeImmutable ? $at : new \DateTimeImmutable((string) $at);
    }

    /** The query behind {@see lastLeftApprovedAt()}. */
    public function lastLeftApprovedAtQuery(string $specialistId): Query
    {
        return $this->em->createQueryBuilder()
            ->select('MAX(e.createdAt)')
            ->from(SpecialistStatusEvent::class, 'e')
            ->andWhere('e.specialistId = :specialist')
            ->andWhere('e.toStatus <> :approved')
            ->setParameter('specialist', $specialistId)
            ->setParameter('approved', 'approved')
            ->getQuery();
    }

    /** The query behind {@see forSpecialist()} (public so its DQL compiles in the offline tests). */
    public function forSpecialistQuery(string $specialistId, int $limit = 200): Query
    {
        return $this->qb()
            ->andWhere('e.specialistId = :specialist')
            ->setParameter('specialist', $specialistId)
            ->orderBy('e.createdAt', 'DESC')
            ->addOrderBy('e.id', 'DESC')
            ->setMaxResults(max(1, min(500, $limit)))
            ->getQuery();
    }
}
