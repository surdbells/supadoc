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

    /**
     * Paginated patient roster for the admin console, newest first, with an
     * optional name/email/phone search.
     *
     * @return array{items: list<Patient>, total: int}
     */
    public function paginatedList(int $offset, int $perPage, ?string $search = null): array
    {
        $qb = $this->qb()->andWhere('e.deletedAt IS NULL');

        if ($search !== null && trim($search) !== '') {
            $like = '%' . strtolower(trim($search)) . '%';
            $qb->andWhere(
                '(LOWER(e.firstName) LIKE :q OR LOWER(e.lastName) LIKE :q '
                . "OR LOWER(CONCAT(e.firstName, ' ', e.lastName)) LIKE :q "
                . 'OR LOWER(e.email) LIKE :q OR e.phone LIKE :q)',
            )->setParameter('q', $like);
        }

        return $this->paginatedQuery($qb, $this->alias(), $offset, $perPage, 'createdAt', 'desc');
    }

    /**
     * Staff lookup by name / email / phone (case-insensitive substring), for the
     * back-office appointment-creation flow.
     *
     * @return list<Patient>
     */
    public function search(string $term, int $limit = 10): array
    {
        $term = trim($term);
        if ($term === '') {
            return [];
        }
        $like = '%' . strtolower($term) . '%';

        return $this->qb()
            ->andWhere('e.deletedAt IS NULL')
            ->andWhere(
                '(LOWER(e.firstName) LIKE :q OR LOWER(e.lastName) LIKE :q '
                . "OR LOWER(CONCAT(e.firstName, ' ', e.lastName)) LIKE :q "
                . 'OR LOWER(e.email) LIKE :q OR e.phone LIKE :q)',
            )
            ->setParameter('q', $like)
            ->orderBy('e.firstName', 'ASC')
            ->setMaxResults(max(1, min(50, $limit)))
            ->getQuery()
            ->getResult();
    }
}
