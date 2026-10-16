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

    // ----- Back office: doctor management (list, filters, licence cron) -----

    /** The back-office list's `?filter=` values. */
    public const ADMIN_FILTERS = [
        'review', 'changes', 'onboarding', 'rejected', 'approved', 'suspended',
        'licence_expiring', 'licence_expired', 'credentials_missing', 'credentials_pending',
    ];

    /** Sorts the back-office list accepts (DQL names; anything else sorts by name). */
    private const ADMIN_SORTS = ['name', 'specialty', 'createdAt', 'submittedAt', 'licenceExpiresAt'];

    /**
     * The back-office list: every doctor not removed, searched by name,
     * specialty, contact email or MDCN number, narrowed by one of
     * {@see ADMIN_FILTERS} (an unknown filter narrows nothing). `$today` is the
     * clinic's date at midnight (how a `date` column hydrates); "expiring"
     * means within 30 days.
     */
    public function adminQuery(?string $search, ?string $filter, \DateTimeImmutable $today): QueryBuilder
    {
        $qb = $this->qb()->andWhere('e.deletedAt IS NULL');
        if ($search !== null && trim($search) !== '') {
            $qb->andWhere('LOWER(e.name) LIKE :q OR LOWER(e.specialty) LIKE :q OR LOWER(e.email) LIKE :q OR LOWER(e.mdcnNumber) LIKE :q')
                ->setParameter('q', '%' . mb_strtolower(trim($search)) . '%');
        }
        $status = static fn (SpecialistStatus $s): QueryBuilder => $qb->andWhere('e.status = :filterStatus')->setParameter('filterStatus', $s->value);
        $live   = static fn (): QueryBuilder => $qb->andWhere('e.status IS NULL OR e.status = :liveStatus')->setParameter('liveStatus', SpecialistStatus::APPROVED->value);

        match ($filter) {
            'review'      => $status(SpecialistStatus::PENDING_REVIEW),
            'onboarding'  => $status(SpecialistStatus::INVITED),
            'rejected'    => $status(SpecialistStatus::REJECTED),
            'suspended'   => $status(SpecialistStatus::SUSPENDED),
            'approved'    => $live(),
            'changes'     => $qb->andWhere('e.pendingChanges IS NOT NULL'),
            'licence_expiring' => $live()
                ->andWhere('e.licenceExpiresAt >= :today AND e.licenceExpiresAt <= :soon')
                ->setParameter('today', $today)
                ->setParameter('soon', $today->modify('+30 days')),
            'licence_expired' => $qb->andWhere('e.licenceExpiresAt < :today')->setParameter('today', $today),
            'credentials_missing' => $qb->andWhere('e.credentialsDueAt IS NOT NULL'),
            'credentials_pending' => $qb
                ->andWhere('EXISTS (SELECT c.id FROM ' . \App\Domain\Entity\SpecialistCredential::class . ' c WHERE c.specialistId = e.id AND c.status = :pendingCredential)')
                ->setParameter('pendingCredential', \App\Domain\Entity\SpecialistCredential::STATUS_PENDING),
            default       => $qb,
        };

        return $qb;
    }

    /**
     * One page of {@see adminQuery()}, sorted by an allow-listed field (then id).
     *
     * @return array{items: list<Specialist>, total: int}
     */
    public function adminPage(
        int $offset,
        int $perPage,
        ?string $search,
        ?string $filter,
        string $sortBy,
        string $sortDir,
        \DateTimeImmutable $today,
    ): array {
        $sortBy = in_array($sortBy, self::ADMIN_SORTS, true) ? $sortBy : 'name';
        $dir    = strtoupper($sortDir) === 'DESC' ? 'DESC' : 'ASC';
        $qb     = $this->adminQuery($search, $filter, $today)
            ->orderBy('e.' . $sortBy, $dir)
            ->addOrderBy('e.id', 'ASC')
            ->setFirstResult(max(0, $offset))
            ->setMaxResults(max(1, $perPage));
        $paginator = new \Doctrine\ORM\Tools\Pagination\Paginator($qb, fetchJoinCollection: false);

        return ['items' => iterator_to_array($paginator), 'total' => count($paginator)];
    }

    /** How many doctors one back-office filter matches (the review-queue counts). */
    public function countAdminFilter(string $filter, \DateTimeImmutable $today): int
    {
        return (int) $this->adminQuery(null, $filter, $today)
            ->select('COUNT(e.id)')
            ->getQuery()
            ->getSingleScalarResult();
    }

    /**
     * Live doctors approved before documents existed (no approval snapshot)
     * who have no "credentials due" date yet — the licence cron gives them one.
     *
     * @return list<Specialist>
     */
    public function legacyWithoutCredentialsDue(): array
    {
        return $this->legacyWithoutCredentialsDueQuery()->getQuery()->getResult();
    }

    public function legacyWithoutCredentialsDueQuery(): QueryBuilder
    {
        return $this->qb()
            ->andWhere('e.deletedAt IS NULL')
            ->andWhere('e.status IS NULL OR e.status = :liveStatus')
            ->andWhere('e.approvedSnapshot IS NULL')
            ->andWhere('e.credentialsDueAt IS NULL')
            ->setParameter('liveStatus', SpecialistStatus::APPROVED->value);
    }

    /**
     * Live doctors who still owe their documents (a "credentials due" date) —
     * the licence cron reminds them.
     *
     * @return list<Specialist>
     */
    public function withCredentialsDue(): array
    {
        return $this->qb()
            ->andWhere('e.deletedAt IS NULL')
            ->andWhere('e.status IS NULL OR e.status = :liveStatus')
            ->andWhere('e.credentialsDueAt IS NOT NULL')
            ->setParameter('liveStatus', SpecialistStatus::APPROVED->value)
            ->getQuery()
            ->getResult();
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

    // ----- Directory search with availability (filters, candidates, facets) -----

    /**
     * The listed directory ({@see directoryQuery()}) with the price and
     * experience filters on top: a fee ceiling, a minimum rating and a minimum
     * number of years in practice (a doctor who never gave theirs is left out
     * once one is asked for). Money stays a decimal string.
     */
    public function searchQuery(
        ?string $search = null,
        ?string $specialty = null,
        ?string $location = null,
        ?string $language = null,
        ?string $gender = null,
        ?bool $inPersonOnly = null,
        ?string $feeMax = null,
        ?string $minRating = null,
        ?int $minYears = null,
    ): QueryBuilder {
        $qb = $this->directoryQuery($search, true, $specialty, $location, $language, $gender, $inPersonOnly);
        if ($feeMax !== null) {
            $qb->andWhere('e.consultationFee <= :feeMax')->setParameter('feeMax', $feeMax);
        }
        if ($minRating !== null) {
            $qb->andWhere('e.rating >= :minRating')->setParameter('minRating', $minRating);
        }
        if ($minYears !== null) {
            $qb->andWhere('e.yearsExperience >= :minYears')->setParameter('minYears', $minYears);
        }

        return $qb;
    }

    /**
     * One page of a directory query, sorted by an allow-listed field.
     *
     * @return array{items: list<Specialist>, total: int}
     */
    public function pageOf(QueryBuilder $qb, int $offset, int $perPage, string $sortBy, string $sortDir): array
    {
        /** @var array{items: list<Specialist>, total: int} */
        return $this->paginatedQuery($qb, $this->alias(), $offset, $perPage, $sortBy, $sortDir);
    }

    /**
     * Up to $cap doctors of a directory query in the requested (allow-listed)
     * order — the candidates a date-filtered search checks availability for
     * before it pages.
     *
     * @return list<Specialist>
     */
    public function candidatesOf(QueryBuilder $qb, string $sortBy, string $sortDir, int $cap): array
    {
        $dir    = strtoupper($sortDir) === 'ASC' ? 'ASC' : 'DESC';
        $sortBy = $this->safeSortField($sortBy);
        $qb->orderBy('e.' . $sortBy, $dir);
        if ($sortBy !== 'id') {
            $qb->addOrderBy('e.id', $dir);
        }

        return $qb->setMaxResults(max(1, $cap))->getQuery()->getResult();
    }

    /**
     * Listed doctors of one specialty (in-person ones when asked), best rated
     * first, without $excludeId — the pool alternative-doctor suggestions are
     * ranked from (the other filters are relaxed in PHP, tier by tier).
     *
     * @return list<Specialist>
     */
    public function suggestionCandidates(string $specialty, bool $inPersonOnly, ?string $excludeId, int $cap): array
    {
        return $this->suggestionCandidatesQuery($specialty, $inPersonOnly, $excludeId)
            ->setMaxResults(max(1, $cap))
            ->getQuery()
            ->getResult();
    }

    /** The query behind {@see suggestionCandidates()} (public so its DQL compiles offline). */
    public function suggestionCandidatesQuery(string $specialty, bool $inPersonOnly, ?string $excludeId): QueryBuilder
    {
        $qb = $this->directoryQuery(null, true, $specialty, null, null, null, $inPersonOnly ? true : null);
        if ($excludeId !== null && $excludeId !== '') {
            $qb->andWhere('e.id != :exclude')->setParameter('exclude', $excludeId);
        }

        return $qb->orderBy('e.rating', 'DESC')->addOrderBy('e.reviewsCount', 'DESC')->addOrderBy('e.id', 'ASC');
    }

    /**
     * The genders listed doctors gave (lower-case, alphabetical) — for the
     * directory's gender filter.
     *
     * @return list<string>
     */
    public function distinctGenders(): array
    {
        $rows = $this->onlyListed($this->qb())
            ->select('DISTINCT LOWER(e.gender) AS gender')
            ->andWhere('e.deletedAt IS NULL')
            ->andWhere('e.gender IS NOT NULL')
            ->getQuery()
            ->getScalarResult();

        $out = array_values(array_unique(array_filter(array_map(
            static fn (array $row): string => trim((string) $row['gender']),
            $rows,
        ))));
        sort($out);

        return $out;
    }

    /**
     * The cheapest and dearest consultation fee among listed doctors (decimal
     * strings), or null when nobody is listed — the fee filter's range.
     *
     * @return array{min:string, max:string}|null
     */
    public function feeRange(): ?array
    {
        $row = $this->onlyListed($this->qb())
            ->select('MIN(e.consultationFee) AS lo, MAX(e.consultationFee) AS hi')
            ->andWhere('e.deletedAt IS NULL')
            ->getQuery()
            ->getSingleResult();

        if (($row['lo'] ?? null) === null) {
            return null;
        }

        return ['min' => (string) $row['lo'], 'max' => (string) $row['hi']];
    }

    // ----- Reference data: specialty usage counts + renames -----

    /**
     * Every stored specialty spelling with how many doctors (not deleted) have
     * it. The reference list's usage counts group these by
     * {@see \App\Domain\Entity\ReferenceItem::keyOf()} (case and spacing aside).
     *
     * @return array<string,int> stored value => doctors
     */
    public function specialtyUsage(): array
    {
        $out = [];
        foreach ($this->specialtyUsageQuery()->getScalarResult() as $row) {
            $out[(string) $row['specialty']] = (int) $row['cnt'];
        }

        return $out;
    }

    /** {@see specialtyUsage()}'s query (public so its DQL compiles in the offline tests). */
    public function specialtyUsageQuery(): \Doctrine\ORM\Query
    {
        return $this->qb()
            ->select('e.specialty AS specialty, COUNT(e.id) AS cnt')
            ->andWhere('e.deletedAt IS NULL')
            ->groupBy('e.specialty')
            ->getQuery();
    }

    /**
     * The specialties asked for by change requests waiting for review (doctors
     * not deleted), with how many requests ask for each — a list item they
     * name must not be deleted, or the doctor would hold a label that is not
     * on the list once the request is approved. Waiting requests are few, so
     * they are read and decoded here (like {@see renameSpecialty()}).
     *
     * @return array<string,int> requested value => requests
     */
    public function requestedSpecialtyUsage(): array
    {
        $out  = [];
        $rows = $this->em->getConnection()->fetchFirstColumn(
            'SELECT pending_changes FROM specialists WHERE pending_changes IS NOT NULL AND deleted_at IS NULL',
        );
        foreach ($rows as $json) {
            $pending = json_decode((string) $json, true);
            $wanted  = is_array($pending) && is_array($pending['fields'] ?? null) ? ($pending['fields']['specialty'] ?? null) : null;
            if (is_string($wanted) && trim($wanted) !== '') {
                $out[$wanted] = ($out[$wanted] ?? 0) + 1;
            }
        }

        return $out;
    }

    /**
     * A specialty was renamed in the reference list: give every specialist
     * whose specialty reads as `$from` (any case or spacing; deleted rows too,
     * so a restored doctor still matches the list) the new label, and the same
     * for a change request waiting for review that asks for it. Run it inside
     * the rename's transaction. Returns each change for the audit — `pending`
     * marks a waiting change request rather than the specialty itself.
     *
     * @return list<array{id:string, name:string, from:string, pending:bool}>
     */
    public function renameSpecialty(string $from, string $to): array
    {
        $key     = \App\Domain\Entity\ReferenceItem::keyOf($from);
        $to      = \App\Domain\Entity\ReferenceItem::normaliseLabel($to);
        $changes = [];

        // The stored spellings that read as $from (a short list: one row per spelling).
        $spellings = [];
        foreach ($this->qb()->select('DISTINCT e.specialty AS specialty')->getQuery()->getScalarResult() as $row) {
            $value = (string) $row['specialty'];
            if ($value !== $to && \App\Domain\Entity\ReferenceItem::keyOf($value) === $key) {
                $spellings[] = $value;
            }
        }
        if ($spellings !== []) {
            $rows = $this->qb()
                ->select('e.id AS id, e.name AS name, e.specialty AS specialty')
                ->andWhere('e.specialty IN (:spellings)')
                ->setParameter('spellings', $spellings)
                ->orderBy('e.name', 'ASC')
                ->getQuery()
                ->getScalarResult();
            foreach ($rows as $row) {
                $changes[] = ['id' => (string) $row['id'], 'name' => (string) $row['name'], 'from' => (string) $row['specialty'], 'pending' => false];
            }
            $this->em->createQueryBuilder()
                ->update(Specialist::class, 'e')
                ->set('e.specialty', ':to')
                ->set('e.updatedAt', ':now')
                ->andWhere('e.specialty IN (:spellings)')
                ->setParameter('to', $to)
                ->setParameter('now', new \DateTimeImmutable(), 'datetime_immutable')
                ->setParameter('spellings', $spellings)
                ->getQuery()
                ->execute();
        }

        // Change requests waiting for review (few at a time) that ask for $from.
        $conn = $this->em->getConnection();
        foreach ($conn->fetchAllAssociative('SELECT id, name, pending_changes FROM specialists WHERE pending_changes IS NOT NULL') as $row) {
            $pending = json_decode((string) $row['pending_changes'], true);
            $wanted  = is_array($pending) ? ($pending['fields']['specialty'] ?? null) : null;
            if (!is_string($wanted) || $wanted === $to || \App\Domain\Entity\ReferenceItem::keyOf($wanted) !== $key) {
                continue;
            }
            $pending['fields']['specialty'] = $to;
            $conn->update(
                'specialists',
                ['pending_changes' => json_encode($pending, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)],
                ['id' => (string) $row['id']],
            );
            $changes[] = ['id' => trim((string) $row['id']), 'name' => (string) $row['name'], 'from' => $wanted, 'pending' => true];
        }

        return $changes;
    }
}
