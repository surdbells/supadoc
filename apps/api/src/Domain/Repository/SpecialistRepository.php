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
        ?string $location = null,
        ?string $language = null,
        ?string $gender = null,
        ?bool $inPersonOnly = null,
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
        if ($location !== null && $location !== '') {
            $qb->andWhere('LOWER(e.location) = :location')
                ->setParameter('location', strtolower($location));
        }
        if ($language !== null && $language !== '') {
            $qb->andWhere('LOWER(e.languages) LIKE :language')
                ->setParameter('language', '%' . strtolower($language) . '%');
        }
        if ($gender !== null && $gender !== '') {
            $qb->andWhere('LOWER(e.gender) = :gender')
                ->setParameter('gender', strtolower($gender));
        }
        if ($inPersonOnly === true) {
            $qb->andWhere('e.offersInPerson = true');
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

    /**
     * Each specialty with its number of specialists — for the homepage's
     * "browse by department" cards.
     *
     * @return list<array{name:string,count:int}>
     */
    /**
     * Distinct specialist locations, alphabetical — for the location filter.
     *
     * @return list<string>
     */
    public function distinctLocations(): array
    {
        $rows = $this->qb()
            ->select('DISTINCT e.location AS loc')
            ->andWhere('e.deletedAt IS NULL')
            ->andWhere('e.location IS NOT NULL')
            ->orderBy('e.location', 'ASC')
            ->getQuery()
            ->getScalarResult();

        return array_values(array_filter(array_map(
            static fn (array $row): string => (string) $row['loc'],
            $rows,
        )));
    }

    /**
     * Distinct languages across specialists (the stored value is a comma list),
     * alphabetical — for the language filter.
     *
     * @return list<string>
     */
    public function distinctLanguages(): array
    {
        $rows = $this->qb()
            ->select('DISTINCT e.languages AS langs')
            ->andWhere('e.deletedAt IS NULL')
            ->andWhere('e.languages IS NOT NULL')
            ->getQuery()
            ->getScalarResult();

        $set = [];
        foreach ($rows as $row) {
            foreach (explode(',', (string) $row['langs']) as $lang) {
                $lang = trim($lang);
                if ($lang !== '') {
                    $set[$lang] = true;
                }
            }
        }
        $out = array_keys($set);
        sort($out);

        return $out;
    }

    public function specialtyCounts(): array
    {
        $rows = $this->qb()
            ->select('e.specialty AS name, COUNT(e.id) AS cnt')
            ->andWhere('e.deletedAt IS NULL')
            ->groupBy('e.specialty')
            ->orderBy('e.specialty', 'ASC')
            ->getQuery()
            ->getResult();

        return array_map(
            static fn (array $row): array => [
                'name'  => (string) $row['name'],
                'count' => (int) $row['cnt'],
            ],
            $rows,
        );
    }
}
