<?php

declare(strict_types=1);

namespace App\Domain\Repository;

use App\Domain\Entity\Notification;
use App\Domain\Enum\NotificationType;
use BackedEnum;
use DateTimeImmutable;
use Doctrine\ORM\Query;

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
        ?NotificationType $type = null,
        ?DateTimeImmutable $before = null,
    ): array {
        $qb = $this->qb()
            ->andWhere('e.patient = :patient')
            ->setParameter('patient', $patientId);

        if ($unreadOnly === true) {
            $qb->andWhere('e.readAt IS NULL');
        }
        if ($type !== null) {
            $qb->andWhere('e.type = :type')->setParameter('type', $type->value);
        }
        // Inclusive: timestamps are to the second, so others from that same
        // second are included again (the client drops ones it already has).
        if ($before !== null) {
            $qb->andWhere('e.createdAt <= :before')->setParameter('before', $before);
        }

        return $this->paginatedQuery($qb, $this->alias(), $offset, $perPage, 'createdAt', 'desc');
    }

    /**
     * How many notifications (and how many unread) the patient has of each type
     * — every type is present, zero when there are none. Feeds the filter tabs.
     *
     * @return array<string, array{total: int, unread: int}>
     */
    public function countsByType(string $patientId): array
    {
        $counts = [];
        foreach (NotificationType::cases() as $type) {
            $counts[$type->value] = ['total' => 0, 'unread' => 0];
        }
        foreach ($this->countsByTypeQuery($patientId)->getScalarResult() as $row) {
            $type = $row['type'] instanceof BackedEnum ? (string) $row['type']->value : (string) $row['type'];
            if (isset($counts[$type])) {
                $counts[$type] = ['total' => (int) $row['total'], 'unread' => (int) $row['unread']];
            }
        }

        return $counts;
    }

    /** The grouped count query behind {@see countsByType()}. */
    public function countsByTypeQuery(string $patientId): Query
    {
        return $this->em->createQueryBuilder()
            ->select('e.type AS type', 'COUNT(e.id) AS total', 'SUM(CASE WHEN e.readAt IS NULL THEN 1 ELSE 0 END) AS unread')
            ->from(Notification::class, 'e')
            ->andWhere('e.patient = :patient')
            ->setParameter('patient', $patientId)
            ->groupBy('e.type')
            ->getQuery();
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
