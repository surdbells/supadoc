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
}
