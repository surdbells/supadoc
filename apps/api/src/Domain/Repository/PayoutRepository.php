<?php

declare(strict_types=1);

namespace App\Domain\Repository;

use App\Domain\Entity\Payout;

final class PayoutRepository extends BaseRepository
{
    protected function getEntityClass(): string
    {
        return Payout::class;
    }

    /**
     * A specialist's payouts, newest first.
     *
     * @return list<Payout>
     */
    public function forSpecialist(string $specialistId, int $limit = 100): array
    {
        return $this->qb()
            ->andWhere('e.specialistId = :specialist')
            ->setParameter('specialist', $specialistId)
            ->orderBy('e.createdAt', 'DESC')
            ->setMaxResults($limit)
            ->getQuery()
            ->getResult();
    }

    /**
     * Sum of a specialist's payouts that are not rejected (pending/approved/paid) —
     * i.e. funds already committed against their earnings.
     */
    public function committedTotalForSpecialist(string $specialistId): string
    {
        $sum = $this->em->createQueryBuilder()
            ->select('COALESCE(SUM(e.amount), 0)')
            ->from(Payout::class, 'e')
            ->andWhere('e.specialistId = :specialist')
            ->andWhere('e.status != :rejected')
            ->setParameter('specialist', $specialistId)
            ->setParameter('rejected', Payout::STATUS_REJECTED)
            ->getQuery()
            ->getSingleScalarResult();

        return number_format((float) $sum, 2, '.', '');
    }

    public function hasOpenRequest(string $specialistId): bool
    {
        $count = (int) $this->em->createQueryBuilder()
            ->select('COUNT(e.id)')
            ->from(Payout::class, 'e')
            ->andWhere('e.specialistId = :specialist')
            ->andWhere('e.status IN (:open)')
            ->setParameter('specialist', $specialistId)
            ->setParameter('open', [Payout::STATUS_PENDING, Payout::STATUS_APPROVED])
            ->getQuery()
            ->getSingleScalarResult();

        return $count > 0;
    }

    /**
     * Paginated payouts across all doctors (back office), optional status filter.
     *
     * @return array{items: list<Payout>, total: int}
     */
    public function paginatedAll(int $offset, int $perPage, ?string $status = null): array
    {
        $qb = $this->qb();
        if ($status !== null && $status !== '') {
            $qb->andWhere('e.status = :status')->setParameter('status', $status);
        }

        return $this->paginatedQuery($qb, $this->alias(), $offset, $perPage, 'createdAt', 'desc');
    }
}
