<?php

declare(strict_types=1);

namespace App\Domain\Repository;

use App\Domain\Entity\PayoutAccount;

final class PayoutAccountRepository extends BaseRepository
{
    protected function getEntityClass(): string
    {
        return PayoutAccount::class;
    }

    public function forSpecialist(string $specialistId): ?PayoutAccount
    {
        return $this->qb()
            ->andWhere('e.specialistId = :specialist')
            ->setParameter('specialist', $specialistId)
            ->getQuery()
            ->getOneOrNullResult();
    }
}
