<?php

declare(strict_types=1);

namespace App\Domain\Repository;

use App\Domain\Entity\Drug;

final class DrugRepository extends BaseRepository
{
    protected function getEntityClass(): string
    {
        return Drug::class;
    }

    public function findByRxcui(string $rxcui): ?Drug
    {
        $drug = $this->find($rxcui);

        return $drug instanceof Drug ? $drug : null;
    }

    /**
     * Products whose search text contains every term (case-insensitive). Names
     * that start with the first term come first, then generic products (generic
     * prescribing is the default), then shorter names — so "amoxicillin 500"
     * puts the plain generic capsule on top.
     *
     * @param list<string> $terms lower-case search terms (already alias-expanded)
     * @return list<Drug>
     */
    public function search(array $terms, int $limit = 20): array
    {
        if ($terms === []) {
            return [];
        }
        $qb = $this->qb()
            ->addSelect('CASE WHEN e.searchText LIKE :lead THEN 0 ELSE 1 END AS HIDDEN lead_first')
            ->addSelect('CASE WHEN e.tty = :scd OR e.tty = :gpck THEN 0 ELSE 1 END AS HIDDEN generic_first')
            ->addSelect('LENGTH(e.name) AS HIDDEN name_len')
            ->setParameter('lead', addcslashes($terms[0], '%_\\') . '%')
            ->setParameter('scd', 'SCD')
            ->setParameter('gpck', 'GPCK');
        foreach (array_values($terms) as $i => $term) {
            $qb->andWhere("e.searchText LIKE :t{$i}")
                ->setParameter("t{$i}", '%' . addcslashes($term, '%_\\') . '%');
        }

        return $qb->orderBy('lead_first', 'ASC')
            ->addOrderBy('generic_first', 'ASC')
            ->addOrderBy('name_len', 'ASC')
            ->setMaxResults(max(1, min($limit, 50)))
            ->getQuery()
            ->getResult();
    }
}
