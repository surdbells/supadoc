<?php

declare(strict_types=1);

namespace App\Domain\Repository;

use App\Domain\Entity\User;

final class UserRepository extends BaseRepository
{
    protected function getEntityClass(): string
    {
        return User::class;
    }

    public function findByEmail(string $email): ?User
    {
        // Postgres `=` is case-sensitive — normalise at the edge (ARCHITECTURE §11).
        return $this->qb()
            ->andWhere('e.email = :email')
            ->andWhere('e.deletedAt IS NULL')
            ->setParameter('email', strtolower(trim($email)))
            ->getQuery()
            ->getOneOrNullResult();
    }

    /**
     * All staff users (non-deleted), by name — the back-office staff directory.
     *
     * @return list<User>
     */
    public function all(int $limit = 500): array
    {
        return $this->qb()
            ->andWhere('e.deletedAt IS NULL')
            ->orderBy('e.firstName', 'ASC')
            ->addOrderBy('e.lastName', 'ASC')
            ->setMaxResults(max(1, min(1000, $limit)))
            ->getQuery()
            ->getResult();
    }
}
