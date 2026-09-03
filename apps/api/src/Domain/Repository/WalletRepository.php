<?php

declare(strict_types=1);

namespace App\Domain\Repository;

use App\Domain\Entity\Wallet;

final class WalletRepository extends BaseRepository
{
    protected function getEntityClass(): string
    {
        return Wallet::class;
    }

    /** A patient's wallet for a currency, or null if not created yet. */
    public function findFor(string $patientId, string $currency): ?Wallet
    {
        return $this->getRepo()->findOneBy([
            'patientId' => $patientId,
            'currency'  => strtoupper($currency),
        ]);
    }

    /** Every wallet a patient holds (one per currency). @return list<Wallet> */
    public function allFor(string $patientId): array
    {
        return $this->qb()
            ->andWhere('e.patientId = :patient')
            ->setParameter('patient', $patientId)
            ->orderBy('e.currency', 'ASC')
            ->getQuery()
            ->getResult();
    }
}
