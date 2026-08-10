<?php

declare(strict_types=1);

namespace App\Domain\Repository;

use App\Domain\Entity\Session;

final class SessionRepository extends BaseRepository
{
    protected function getEntityClass(): string
    {
        return Session::class;
    }

    /** A live (non-revoked) session by id, or null. */
    public function findActive(string $id): ?Session
    {
        return $this->qb()
            ->andWhere('e.id = :id')
            ->andWhere('e.revokedAt IS NULL')
            ->setParameter('id', $id)
            ->getQuery()
            ->getOneOrNullResult();
    }

    /**
     * A patient's live sessions, newest first.
     *
     * @return list<Session>
     */
    public function listForPatient(string $patientId): array
    {
        return $this->qb()
            ->andWhere('e.patient = :patient')
            ->andWhere('e.revokedAt IS NULL')
            ->orderBy('e.createdAt', 'DESC')
            ->setParameter('patient', $patientId)
            ->getQuery()
            ->getResult();
    }

    /** A session by id, scoped to its owner (so one patient can't revoke another's). */
    public function findForPatient(string $id, string $patientId): ?Session
    {
        return $this->qb()
            ->andWhere('e.id = :id')
            ->andWhere('e.patient = :patient')
            ->setParameter('id', $id)
            ->setParameter('patient', $patientId)
            ->getQuery()
            ->getOneOrNullResult();
    }
}
