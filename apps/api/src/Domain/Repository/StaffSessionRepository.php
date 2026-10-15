<?php

declare(strict_types=1);

namespace App\Domain\Repository;

use App\Domain\Entity\StaffSession;
use DateTimeImmutable;
use Doctrine\ORM\Query;

final class StaffSessionRepository extends BaseRepository
{
    protected function getEntityClass(): string
    {
        return StaffSession::class;
    }

    /** Sign out every live session of a staff user at once; returns how many. */
    public function revokeAllForUser(string $userId, ?DateTimeImmutable $now = null): int
    {
        return (int) $this->revokeAllForUserQuery($userId, $now ?? new DateTimeImmutable())->execute();
    }

    /** The bulk update behind {@see revokeAllForUser()} (public so its DQL compiles in the offline tests). */
    public function revokeAllForUserQuery(string $userId, DateTimeImmutable $now): Query
    {
        return $this->em->createQueryBuilder()
            ->update(StaffSession::class, 's')
            ->set('s.revokedAt', ':now')
            ->where('s.user = :user')
            ->andWhere('s.revokedAt IS NULL')
            ->setParameter('now', $now)
            ->setParameter('user', $userId)
            ->getQuery();
    }
}
