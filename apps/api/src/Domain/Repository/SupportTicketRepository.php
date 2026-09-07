<?php

declare(strict_types=1);

namespace App\Domain\Repository;

use App\Domain\Entity\SupportTicket;

final class SupportTicketRepository extends BaseRepository
{
    protected function getEntityClass(): string
    {
        return SupportTicket::class;
    }

    /**
     * The patient's own tickets, most recently active first.
     *
     * @return array{items: list<SupportTicket>, total: int}
     */
    public function paginatedForPatient(int $offset, int $perPage, string $patientId): array
    {
        $qb = $this->qb()
            ->andWhere('e.patientId = :patient')
            ->setParameter('patient', $patientId);

        return $this->paginatedQuery($qb, $this->alias(), $offset, $perPage, 'lastMessageAt', 'desc');
    }

    /**
     * The back-office queue, optionally filtered by status, most recently active first.
     *
     * @return array{items: list<SupportTicket>, total: int}
     */
    public function paginatedAll(int $offset, int $perPage, ?string $status = null): array
    {
        $qb = $this->qb();
        if ($status !== null && in_array($status, SupportTicket::STATUSES, true)) {
            $qb->andWhere('e.status = :status')->setParameter('status', $status);
        }

        return $this->paginatedQuery($qb, $this->alias(), $offset, $perPage, 'lastMessageAt', 'desc');
    }

    /** Count of tickets awaiting a support reply (the queue badge). */
    public function openCount(): int
    {
        return (int) $this->em->createQueryBuilder()
            ->select('COUNT(e.id)')
            ->from(SupportTicket::class, 'e')
            ->andWhere('e.status = :open')
            ->setParameter('open', 'open')
            ->getQuery()
            ->getSingleScalarResult();
    }
}
