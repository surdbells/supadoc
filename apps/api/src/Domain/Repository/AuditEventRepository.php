<?php

declare(strict_types=1);

namespace App\Domain\Repository;

use App\Domain\Entity\AuditEvent;
use Doctrine\ORM\Query;

final class AuditEventRepository extends BaseRepository
{
    protected function getEntityClass(): string
    {
        return AuditEvent::class;
    }

    /** Whether events can still be saved (false once a failed transaction closed the entity manager). */
    public function isWritable(): bool
    {
        return $this->em->isOpen();
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
     * Everything recorded against one resource (e.g. a doctor:
     * `specialist` / their id), newest first.
     *
     * @return list<AuditEvent>
     */
    public function forResource(string $resourceType, string $resourceId, int $limit = 200): array
    {
        return $this->forResourceQuery($resourceType, $resourceId, $limit)->getResult();
    }

    /** The query behind {@see forResource()} (public so its DQL compiles in the offline tests). */
    public function forResourceQuery(string $resourceType, string $resourceId, int $limit = 200): Query
    {
        return $this->qb()
            ->andWhere('e.resourceType = :type')
            ->andWhere('e.resourceId = :id')
            ->setParameter('type', $resourceType)
            ->setParameter('id', $resourceId)
            ->orderBy('e.createdAt', 'DESC')
            ->setMaxResults(max(1, min(500, $limit)))
            ->getQuery();
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
