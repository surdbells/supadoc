<?php

declare(strict_types=1);

namespace App\Domain\Repository;

use App\Domain\Entity\Notification;
use DateTimeImmutable;

final class NotificationRepository extends BaseRepository
{
    protected function getEntityClass(): string
    {
        return Notification::class;
    }

    /**
     * @return array{items: list<Notification>, total: int}
     */
    public function paginated(
        int $offset,
        int $perPage,
        string $patientId,
        ?bool $unreadOnly = null,
    ): array {
        $qb = $this->qb()
            ->andWhere('e.patient = :patient')
            ->setParameter('patient', $patientId);

        if ($unreadOnly === true) {
            $qb->andWhere('e.readAt IS NULL');
        }

        return $this->paginatedQuery($qb, $this->alias(), $offset, $perPage, 'createdAt', 'desc');
    }

    public function unreadCount(string $patientId): int
    {
        return (int) $this->em->createQueryBuilder()
            ->select('COUNT(e.id)')
            ->from(Notification::class, 'e')
            ->andWhere('e.patient = :patient')
            ->andWhere('e.readAt IS NULL')
            ->setParameter('patient', $patientId)
            ->getQuery()
            ->getSingleScalarResult();
    }

    public function findForPatient(string $id, string $patientId): ?Notification
    {
        return $this->qb()
            ->andWhere('e.id = :id')
            ->andWhere('e.patient = :patient')
            ->setParameter('id', $id)
            ->setParameter('patient', $patientId)
            ->getQuery()
            ->getOneOrNullResult();
    }

    public function markAllRead(string $patientId): void
    {
        $this->em->createQueryBuilder()
            ->update(Notification::class, 'e')
            ->set('e.readAt', ':now')
            ->andWhere('e.patient = :patient')
            ->andWhere('e.readAt IS NULL')
            ->setParameter('now', new DateTimeImmutable())
            ->setParameter('patient', $patientId)
            ->getQuery()
            ->execute();
    }
}
