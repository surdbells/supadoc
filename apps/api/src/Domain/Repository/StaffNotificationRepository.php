<?php

declare(strict_types=1);

namespace App\Domain\Repository;

use App\Domain\Entity\StaffNotification;

final class StaffNotificationRepository extends BaseRepository
{
    protected function getEntityClass(): string
    {
        return StaffNotification::class;
    }

    /**
     * @return array{items: list<StaffNotification>, total: int}
     */
    public function paginatedForUser(int $offset, int $perPage, string $userId, bool $unreadOnly = false): array
    {
        $qb = $this->qb()
            ->andWhere('e.userId = :user')
            ->setParameter('user', $userId);
        if ($unreadOnly) {
            $qb->andWhere('e.readAt IS NULL');
        }

        return $this->paginatedQuery($qb, $this->alias(), $offset, $perPage, 'createdAt', 'desc');
    }

    public function unreadCountForUser(string $userId): int
    {
        return (int) $this->em->createQueryBuilder()
            ->select('COUNT(e.id)')
            ->from(StaffNotification::class, 'e')
            ->andWhere('e.userId = :user')
            ->andWhere('e.readAt IS NULL')
            ->setParameter('user', $userId)
            ->getQuery()
            ->getSingleScalarResult();
    }

    public function markAllRead(string $userId): void
    {
        $this->em->createQueryBuilder()
            ->update(StaffNotification::class, 'e')
            ->set('e.readAt', ':now')
            ->andWhere('e.userId = :user')
            ->andWhere('e.readAt IS NULL')
            ->setParameter('now', new \DateTimeImmutable())
            ->setParameter('user', $userId)
            ->getQuery()
            ->execute();
    }
}
