<?php

declare(strict_types=1);

namespace App\Domain\Repository;

use App\Domain\Entity\ReferenceItem;
use Doctrine\ORM\Query;

/**
 * Reference-data items ({@see ReferenceItem}), one category at a time, in
 * list order (sort_order, then label).
 */
final class ReferenceItemRepository extends BaseRepository
{
    protected function getEntityClass(): string
    {
        return ReferenceItem::class;
    }

    protected function sortableFields(): array
    {
        return ['sortOrder', 'label', 'createdAt', 'id'];
    }

    /**
     * A category's items in list order; only the offered ones when `$activeOnly`.
     *
     * @return list<ReferenceItem>
     */
    public function listFor(string $category, bool $activeOnly = false): array
    {
        /** @var list<ReferenceItem> */
        return $this->listQuery($category, $activeOnly)->getResult();
    }

    /** {@see listFor()}'s query (public so its DQL compiles in the offline tests). */
    public function listQuery(string $category, bool $activeOnly = false): Query
    {
        $qb = $this->qb()
            ->andWhere('e.category = :category')
            ->setParameter('category', $category)
            ->orderBy('e.sortOrder', 'ASC')
            ->addOrderBy('e.labelKey', 'ASC')
            ->addOrderBy('e.id', 'ASC');
        if ($activeOnly) {
            $qb->andWhere('e.active = true');
        }

        return $qb->getQuery();
    }

    /** One item of a category, or null (an id from another category is not found). */
    public function findInCategory(string $category, string $id): ?ReferenceItem
    {
        if ($id === '' || strlen($id) > 36) {
            return null;
        }
        $item = $this->find($id);

        return $item instanceof ReferenceItem && $item->getCategory() === $category ? $item : null;
    }

    /** The item whose label reads as `$label` (case and spacing aside), active or not. */
    public function findByLabel(string $category, string $label): ?ReferenceItem
    {
        $item = $this->getRepo()->findOneBy(['category' => $category, 'labelKey' => ReferenceItem::keyOf($label)]);

        return $item instanceof ReferenceItem ? $item : null;
    }

    public function findByCode(string $category, string $code): ?ReferenceItem
    {
        $item = $this->getRepo()->findOneBy(['category' => $category, 'code' => $code]);

        return $item instanceof ReferenceItem ? $item : null;
    }

    /**
     * How many items of a category are active, locking those rows until the
     * surrounding transaction ends (`SELECT … FOR UPDATE`), so two requests
     * switching off the last two items can't both see "one more is left".
     * Call inside a transaction.
     */
    public function lockedActiveCount(string $category): int
    {
        $ids = $this->em->getConnection()->fetchFirstColumn(
            'SELECT id FROM reference_items WHERE category = :category AND active = true FOR UPDATE',
            ['category' => $category],
        );

        return count($ids);
    }

    /** How many items a category has — offered or not, or only the active ones. */
    public function countFor(string $category, bool $activeOnly = false): int
    {
        $qb = $this->qb()
            ->select('COUNT(e.id)')
            ->andWhere('e.category = :category')
            ->setParameter('category', $category);
        if ($activeOnly) {
            $qb->andWhere('e.active = true');
        }

        return (int) $qb->getQuery()->getSingleScalarResult();
    }

    /** The highest sort_order in a category (0 when it is empty) — a new item goes after it. */
    public function maxSortOrder(string $category): int
    {
        $max = $this->qb()
            ->select('MAX(e.sortOrder)')
            ->andWhere('e.category = :category')
            ->setParameter('category', $category)
            ->getQuery()
            ->getSingleScalarResult();

        return $max === null ? 0 : max(0, (int) $max);
    }

    /**
     * A code not yet taken in the category: `$base`, else `$base-2`, `$base-3`…
     * (shortened to fit {@see ReferenceItem::CODE_MAX}).
     */
    public function uniqueCode(string $category, string $base): string
    {
        // A pick list is short: compare against every code it has.
        $taken = array_flip(array_map(
            static fn (array $row): string => (string) $row['code'],
            $this->qb()
                ->select('e.code AS code')
                ->andWhere('e.category = :category')
                ->setParameter('category', $category)
                ->getQuery()
                ->getScalarResult(),
        ));
        if (!isset($taken[$base])) {
            return $base;
        }
        for ($n = 2; ; $n++) {
            $suffix    = '-' . $n;
            $candidate = rtrim(substr($base, 0, ReferenceItem::CODE_MAX - strlen($suffix)), '-') . $suffix;
            if (!isset($taken[$candidate])) {
                return $candidate;
            }
        }
    }
}
