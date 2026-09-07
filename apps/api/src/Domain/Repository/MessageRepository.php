<?php

declare(strict_types=1);

namespace App\Domain\Repository;

use App\Domain\Entity\Message;

final class MessageRepository extends BaseRepository
{
    protected function getEntityClass(): string
    {
        return Message::class;
    }

    /**
     * The full thread for an appointment, oldest first (chat order).
     *
     * @return list<Message>
     */
    public function forAppointment(string $appointmentId): array
    {
        return $this->qb()
            ->andWhere('e.appointmentId = :appt')
            ->setParameter('appt', $appointmentId)
            ->orderBy('e.createdAt', 'ASC')
            ->getQuery()
            ->getResult();
    }

    /**
     * Mark every message in this thread that the given reader did NOT send as read.
     * Used when a party opens the thread — their counterpart's messages become read.
     */
    public function markReadForRole(string $appointmentId, string $readerRole): void
    {
        $this->em->createQueryBuilder()
            ->update(Message::class, 'e')
            ->set('e.readAt', ':now')
            ->andWhere('e.appointmentId = :appt')
            ->andWhere('e.senderRole != :role')
            ->andWhere('e.readAt IS NULL')
            ->setParameter('now', new \DateTimeImmutable())
            ->setParameter('appt', $appointmentId)
            ->setParameter('role', $readerRole)
            ->getQuery()
            ->execute();
    }

    /** Count of messages in this thread not sent by, and not yet read by, the reader. */
    public function unreadForRole(string $appointmentId, string $readerRole): int
    {
        return (int) $this->em->createQueryBuilder()
            ->select('COUNT(e.id)')
            ->from(Message::class, 'e')
            ->andWhere('e.appointmentId = :appt')
            ->andWhere('e.senderRole != :role')
            ->andWhere('e.readAt IS NULL')
            ->setParameter('appt', $appointmentId)
            ->setParameter('role', $readerRole)
            ->getQuery()
            ->getSingleScalarResult();
    }
}
