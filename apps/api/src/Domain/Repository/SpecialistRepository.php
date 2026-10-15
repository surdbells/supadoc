<?php

declare(strict_types=1);

namespace App\Domain\Repository;

use App\Domain\Entity\Specialist;
use App\Domain\Enum\SpecialistStatus;
use Doctrine\ORM\QueryBuilder;

final class SpecialistRepository extends BaseRepository
{
    protected function getEntityClass(): string
    {
        return Specialist::class;
    }

    /** `?sort_by=` values the doctor directory accepts (see BaseRepository::safeSortField). */
    protected function sortableFields(): array
    {
        return ['name', 'rating', 'consultationFee', 'yearsExperience', 'reviewsCount', 'createdAt', 'id'];
    }

    /**
     * The directory, filtered. Only approved doctors (or legacy rows with no
     * status) who are available for booking are included unless `$approvedOnly`
     * is false — the back office passes false to see everyone, onboarding and
     * switched-off doctors included (`$availableOnly` then narrows it).
     *
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
        bool $approvedOnly = true,
    ): array {
        $qb = $this->directoryQuery(
            $search,
            $availableOnly,
            $specialty,
            $location,
            $language,
            $gender,
            $inPersonOnly,
            $approvedOnly,
        );

        return $this->paginatedQuery($qb, $this->alias(), $offset, $perPage, $sortBy, $sortDir);
    }

    /** The directory's filters as a query builder (public so its DQL is testable offline). */
    public function directoryQuery(
        ?string $search = null,
        ?bool $availableOnly = null,
        ?string $specialty = null,
        ?string $location = null,
        ?string $language = null,
        ?string $gender = null,
        ?bool $inPersonOnly = null,
        bool $approvedOnly = true,
    ): QueryBuilder {
        $qb = $this->qb()->andWhere('e.deletedAt IS NULL');
        if ($approvedOnly) {
            $this->onlyListed($qb); // approved (or legacy) and available
        } elseif ($availableOnly === true) {
            $qb->andWhere('e.available = true');
        }

        if ($search !== null && $search !== '') {
            $qb->andWhere('LOWER(e.name) LIKE :q OR LOWER(e.specialty) LIKE :q')
                ->setParameter('q', '%' . strtolower($search) . '%');
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

        return $qb;
    }

    /**
     * Limit a query to doctors the public directory lists (the listing and its
     * facets): approved, or a legacy row with no status (doctors from before
     * onboarding existed — never hide those), AND switched on for bookings.
     */
    public function onlyListed(QueryBuilder $qb): QueryBuilder
    {
        return $qb
            ->andWhere('(e.status IS NULL OR e.status = :listedStatus)')
            ->andWhere('e.available = true')
            ->setParameter('listedStatus', SpecialistStatus::APPROVED->value);
    }

    /** How many doctors have submitted their profile and wait for review (back-office badge). */
    public function countPendingReview(): int
    {
        return (int) $this->qb()
            ->select('COUNT(e.id)')
            ->andWhere('e.deletedAt IS NULL')
            ->andWhere('e.status = :pending')
            ->setParameter('pending', SpecialistStatus::PENDING_REVIEW->value)
            ->getQuery()
            ->getSingleScalarResult();
    }

    /**
     * The distinct set of specialties across bookable specialists, alphabetical —
     * used to populate the directory's specialty filter.
     *
     * @return list<string>
     */
    public function distinctSpecialties(): array
    {
        $rows = $this->onlyListed($this->qb())
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
     * Distinct specialist locations, alphabetical — for the location filter.
     *
     * @return list<string>
     */
    public function distinctLocations(): array
    {
        $rows = $this->onlyListed($this->qb())
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
        $rows = $this->onlyListed($this->qb())
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

    /**
     * Each specialty with its number of listed specialists — for the homepage's
     * "browse by department" cards.
     *
     * @return list<array{name:string,count:int}>
     */
    public function specialtyCounts(): array
    {
        $rows = $this->onlyListed($this->qb())
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
