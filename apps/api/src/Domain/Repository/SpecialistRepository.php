<?php

declare(strict_types=1);

namespace App\Domain\Repository;

use App\Domain\Entity\Specialist;

final class SpecialistRepository extends BaseRepository
{
    protected function getEntityClass(): string
    {
        return Specialist::class;
    }

    /**
     * @return array{items: list<Specialist>, total: int}
     */
    public function paginated(
        int $offset,
        int $perPage,
        string $sortBy = 'createdAt',
        string $sortDir = 'desc',
        ?string $search = null,
        ?bool $availableOnly = null,
        ?string $specialty = null,
    ): array {
        $qb = $this->qb()->andWhere('e.deletedAt IS NULL');

        if ($search !== null && $search !== '') {
            $qb->andWhere('LOWER(e.name) LIKE :q OR LOWER(e.specialty) LIKE :q')
                ->setParameter('q', '%' . strtolower($search) . '%');
        }
        if ($availableOnly === true) {
            $qb->andWhere('e.available = true');
        }
        if ($specialty !== null && $specialty !== '') {
            $qb->andWhere('LOWER(e.specialty) = :specialty')
                ->setParameter('specialty', strtolower($specialty));
        }

        return $this->paginatedQuery($qb, $this->alias(), $offset, $perPage, $sortBy, $sortDir);
    }

    /**
     * The distinct set of specialties across bookable specialists, alphabetical —
     * used to populate the directory's specialty filter.
     *
     * @return list<string>
     */
    public function distinctSpecialties(): array
    {
        $rows = $this->qb()
            ->select('DISTINCT e.specialty AS specialty')
            ->andWhere('e.deletedAt IS NULL')
            ->orderBy('e.specialty', 'ASC')
            ->getQuery()
            ->getScalarResult();

        return array_values(array_filter(array_map(
            static fn (array $row): string => (string) $row['specialty'],
            $rows,
        )));
    }
}
