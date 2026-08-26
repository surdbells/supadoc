<?php

declare(strict_types=1);

namespace App\Domain\Repository;

use App\Domain\Entity\AuditEvent;

final class AuditEventRepository extends BaseRepository
{
    protected function getEntityClass(): string
    {
        return AuditEvent::class;
    }

    /**
     * Audit trail for one consultation, newest first.
     *
     * @return list<AuditEvent>
     */
    public function forAppointment(string $appointmentId, int $limit = 200): array
    {
        return $this->qb()
            ->andWhere('e.appointmentId = :appointment')
            ->setParameter('appointment', $appointmentId)
            ->orderBy('e.createdAt', 'DESC')
            ->setMaxResults($limit)
            ->getQuery()
            ->getResult();
    }
}
