<?php

declare(strict_types=1);

namespace App\Domain\Repository;

use App\Domain\Entity\WalletTransaction;

final class WalletTransactionRepository extends BaseRepository
{
    protected function getEntityClass(): string
    {
        return WalletTransaction::class;
    }

    /** Find a ledger entry by our idempotency reference. */
    public function byReference(string $reference): ?WalletTransaction
    {
        return $this->getRepo()->findOneBy(['reference' => $reference]);
    }

    /**
     * A wallet's ledger, newest first, optionally filtered by type.
     *
     * @return array{items: list<WalletTransaction>, total: int}
     */
    public function page(string $walletId, int $offset, int $perPage, ?string $type = null): array
    {
        $qb = $this->qb()
            ->andWhere('e.walletId = :wallet')
            ->setParameter('wallet', $walletId);

        if ($type !== null && $type !== '' && $type !== 'all') {
            $qb->andWhere('e.type = :type')->setParameter('type', $type);
        }

        return $this->paginatedQuery($qb, $this->alias(), $offset, $perPage, 'createdAt', 'desc');
    }

    /**
     * Recent successful ledger entries for a wallet (dashboard preview).
     *
     * @return list<WalletTransaction>
     */
    public function recentSuccessful(string $walletId, int $limit = 4): array
    {
        return $this->qb()
            ->andWhere('e.walletId = :wallet')
            ->andWhere('e.status = :success')
            ->setParameter('wallet', $walletId)
            ->setParameter('success', WalletTransaction::STATUS_SUCCESS)
            ->orderBy('e.createdAt', 'DESC')
            ->setMaxResults($limit)
            ->getQuery()
            ->getResult();
    }
}
