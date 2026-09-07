<?php

declare(strict_types=1);

namespace App\Domain\Repository;

use App\Domain\Entity\SupportMessage;

final class SupportMessageRepository extends BaseRepository
{
    protected function getEntityClass(): string
    {
        return SupportMessage::class;
    }

    /**
     * A ticket's messages, oldest first (thread order).
     *
     * @return list<SupportMessage>
     */
    public function forTicket(string $ticketId): array
    {
        return $this->qb()
            ->andWhere('e.ticketId = :ticket')
            ->setParameter('ticket', $ticketId)
            ->orderBy('e.createdAt', 'ASC')
            ->getQuery()
            ->getResult();
    }
}
