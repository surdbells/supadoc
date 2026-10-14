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

    /** The staff user linked to a specialist (a doctor login), if any. */
    public function findBySpecialist(string $specialistId): ?User
    {
        return $this->qb()
            ->andWhere('e.specialistId = :specialist')
            ->andWhere('e.deletedAt IS NULL')
            ->setParameter('specialist', $specialistId)
            ->setMaxResults(1)
            ->getQuery()
            ->getOneOrNullResult();
    }

    /** The user holding a one-time set-password link, by the token's hash. */
    public function findByPasswordTokenHash(string $hash): ?User
    {
        return $this->qb()
            ->andWhere('e.passwordTokenHash = :hash')
            ->andWhere('e.deletedAt IS NULL')
            ->setParameter('hash', $hash)
            ->setMaxResults(1)
            ->getQuery()
            ->getOneOrNullResult();
    }

    /**
     * Doctor logins for several specialists at once, keyed by specialist id.
     *
     * @param list<string> $specialistIds
     * @return array<string, User>
     */
    public function findBySpecialistIds(array $specialistIds): array
    {
        if ($specialistIds === []) {
            return [];
        }
        $rows = $this->qb()
            ->andWhere('e.specialistId IN (:ids)')
            ->andWhere('e.deletedAt IS NULL')
            ->setParameter('ids', array_values($specialistIds))
            ->getQuery()
            ->getResult();

        $out = [];
        foreach ($rows as $user) {
            $out[(string) $user->getSpecialistId()] ??= $user;
        }

        return $out;
    }

    /**
     * Active staff who hold a permission (super_admins hold every one). Done in
     * PHP — the grants live in a JSON column and the staff list is small.
     *
     * @return list<User>
     */
    public function withPermission(string $permission): array
    {
        return array_values(array_filter(
            $this->all(),
            static fn (User $u): bool => $u->isActive()
                && (in_array('super_admin', $u->getRoles(), true) || in_array($permission, $u->getPermissions(), true)),
        ));
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
