<?php

declare(strict_types=1);

namespace App\Domain\Repository;

use App\Domain\Entity\WalletTransaction;
use Doctrine\ORM\Query;

final class WalletTransactionRepository extends BaseRepository
{
    protected function getEntityClass(): string
    {
        return WalletTransaction::class;
    }

    /**
     * Find a ledger entry by our idempotency reference.
     *
     * NB: if this request already loaded the entry, Doctrine hands back that
     * in-memory copy as it was then — never decide anything about money on its
     * status. Use {@see byReferenceFresh()} (or WalletService's locked re-read).
     */
    public function byReference(string $reference): ?WalletTransaction
    {
        return $this->getRepo()->findOneBy(['reference' => $reference]);
    }

    /**
     * The entry under `$reference` as the database has it NOW: an already
     * loaded copy is overwritten with the current row. Read under the wallet
     * lock, it is the idempotency check for a posting.
     */
    public function byReferenceFresh(string $reference): ?WalletTransaction
    {
        $txn = $this->byReferenceFreshQuery($reference)->getOneOrNullResult();

        return $txn instanceof WalletTransaction ? $txn : null;
    }

    /** The query behind {@see byReferenceFresh()} (public so its DQL compiles in the offline tests). */
    public function byReferenceFreshQuery(string $reference): Query
    {
        return $this->qb()
            ->andWhere('e.reference = :reference')
            ->setParameter('reference', $reference)
            ->getQuery()
            ->setHint(Query::HINT_REFRESH, true);
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
