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

    /**
     * Platform-wide audit log, newest first, optionally filtered by action.
     *
     * @return array{items: list<AuditEvent>, total: int}
     */
    public function page(int $offset, int $perPage, ?string $action = null): array
    {
        $qb = $this->qb();
        if ($action !== null && $action !== '') {
            $qb->andWhere('e.action = :action')->setParameter('action', $action);
        }

        return $this->paginatedQuery($qb, $this->alias(), $offset, $perPage, 'createdAt', 'desc');
    }
}
