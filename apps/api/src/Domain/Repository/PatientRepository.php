<?php

declare(strict_types=1);

namespace App\Domain\Repository;

use App\Domain\Entity\Patient;

final class PatientRepository extends BaseRepository
{
    protected function getEntityClass(): string
    {
        return Patient::class;
    }

    public function findByEmail(string $email): ?Patient
    {
        return $this->qb()
            ->andWhere('e.email = :email')
            ->andWhere('e.deletedAt IS NULL')
            ->setParameter('email', strtolower(trim($email)))
            ->getQuery()
            ->getOneOrNullResult();
    }

    public function findByPhone(string $phone): ?Patient
    {
        return $this->qb()
            ->andWhere('e.phone = :phone')
            ->andWhere('e.deletedAt IS NULL')
            ->setParameter('phone', trim($phone))
            ->getQuery()
            ->getOneOrNullResult();
    }
}
