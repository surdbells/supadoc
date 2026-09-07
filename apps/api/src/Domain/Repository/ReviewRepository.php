<?php

declare(strict_types=1);

namespace App\Domain\Repository;

use App\Domain\Entity\Review;

final class ReviewRepository extends BaseRepository
{
    protected function getEntityClass(): string
    {
        return Review::class;
    }

    /**
     * A specialist's reviews, newest first.
     *
     * @return array{items: list<Review>, total: int}
     */
    public function paginatedForSpecialist(int $offset, int $perPage, string $specialistId): array
    {
        $qb = $this->qb()
            ->andWhere('e.specialistId = :specialist')
            ->setParameter('specialist', $specialistId);

        return $this->paginatedQuery($qb, $this->alias(), $offset, $perPage, 'createdAt', 'desc');
    }

    public function forAppointment(string $appointmentId): ?Review
    {
        return $this->qb()
            ->andWhere('e.appointmentId = :appointment')
            ->setParameter('appointment', $appointmentId)
            ->setMaxResults(1)
            ->getQuery()
            ->getOneOrNullResult();
    }

    /**
     * Average rating (1 dp string) + count for a specialist, and a 1–5 star
     * distribution.
     *
     * @return array{average: string, count: int, distribution: array<int,int>}
     */
    public function summaryForSpecialist(string $specialistId): array
    {
        $row = $this->em->createQueryBuilder()
            ->select('AVG(e.rating) AS avg_rating, COUNT(e.id) AS c')
            ->from(Review::class, 'e')
            ->andWhere('e.specialistId = :specialist')
            ->setParameter('specialist', $specialistId)
            ->getQuery()
            ->getSingleResult();

        $count   = (int) ($row['c'] ?? 0);
        $average = $count > 0 ? number_format((float) $row['avg_rating'], 1, '.', '') : '0.0';

        $distribution = [1 => 0, 2 => 0, 3 => 0, 4 => 0, 5 => 0];
        $rows = $this->em->createQueryBuilder()
            ->select('e.rating AS rating, COUNT(e.id) AS c')
            ->from(Review::class, 'e')
            ->andWhere('e.specialistId = :specialist')
            ->groupBy('e.rating')
            ->setParameter('specialist', $specialistId)
            ->getQuery()
            ->getScalarResult();
        foreach ($rows as $r) {
            $star = (int) $r['rating'];
            if ($star >= 1 && $star <= 5) {
                $distribution[$star] = (int) $r['c'];
            }
        }

        return ['average' => $average, 'count' => $count, 'distribution' => $distribution];
    }
}
