<?php

declare(strict_types=1);

namespace App\Domain\Repository;

use App\Domain\Entity\DoctorApplication;
use App\Domain\Enum\DoctorApplicationStatus;
use DateTimeImmutable;
use Doctrine\DBAL\LockMode;
use Doctrine\ORM\Query;
use Doctrine\ORM\QueryBuilder;

/**
 * Doctor applications (spec §2.2). Every instant is bound from PHP — no query
 * uses SQL now(); interview times compare as epoch seconds. Queries are exposed
 * as `…Query()` so DoctrineOfflineTest compiles them offline.
 */
final class DoctorApplicationRepository extends BaseRepository
{
    public const FILTERS = ['all', 'needs_action', 'submitted', 'under_review', 'more_info_needed', 'interview_scheduled', 'approved', 'rejected', 'withdrawn'];
    public const SORTS   = ['waiting', 'newest', 'interview'];

    /** How long after its start an interview still on "interview scheduled" needs a decision. */
    public const INTERVIEW_GRACE_SECONDS = 3600;

    protected function getEntityClass(): string
    {
        return DoctorApplication::class;
    }

    protected function alias(): string
    {
        return 'a';
    }

    public function isWritable(): bool
    {
        return $this->em->isOpen();
    }

    /** The row, re-read under a row lock (inside the caller's transaction) — ORM 3.6 refreshes a managed entity. */
    public function findForUpdate(string $id): ?DoctorApplication
    {
        if (!self::isUuid($id)) {
            return null;
        }
        $app = $this->em->find(DoctorApplication::class, $id, LockMode::PESSIMISTIC_WRITE);

        return $app instanceof DoctorApplication ? $app : null;
    }

    public function findApplication(string $id): ?DoctorApplication
    {
        if (!self::isUuid($id)) {
            return null;
        }
        $app = $this->find($id);

        return $app instanceof DoctorApplication ? $app : null;
    }

    public function findByReference(string $reference): ?DoctorApplication
    {
        return $this->findByReferenceQuery($reference)->getOneOrNullResult();
    }

    public function findByReferenceQuery(string $reference): Query
    {
        return $this->qb()
            ->andWhere('a.reference = :reference')
            ->setParameter('reference', $reference)
            ->setMaxResults(1)
            ->getQuery();
    }

    public function referenceTaken(string $reference): bool
    {
        return $this->em->getConnection()->fetchOne('SELECT 1 FROM doctor_applications WHERE reference = ?', [$reference]) !== false;
    }

    /** An open application (submitted … interview_scheduled) for this email, other than `$excludeId`. */
    public function openForEmail(string $email, string $excludeId): ?DoctorApplication
    {
        return $this->openForEmailQuery($email, $excludeId)->getOneOrNullResult();
    }

    public function openForEmailQuery(string $email, string $excludeId): Query
    {
        return $this->qb()
            ->andWhere('a.email = :email')
            ->andWhere('a.status IN (:open)')
            ->andWhere('a.id <> :id')
            ->setParameter('email', strtolower(trim($email)))
            ->setParameter('open', DoctorApplicationStatus::OPEN)
            ->setParameter('id', $excludeId)
            ->setMaxResults(1)
            ->getQuery();
    }

    public function approvedForEmail(string $email): bool
    {
        return (int) $this->approvedForEmailQuery($email)->getSingleScalarResult() > 0;
    }

    public function approvedForEmailQuery(string $email): Query
    {
        return $this->em->createQueryBuilder()
            ->select('COUNT(a.id)')
            ->from(DoctorApplication::class, 'a')
            ->andWhere('a.email = :email')
            ->andWhere('a.status = :approved')
            ->setParameter('email', strtolower(trim($email)))
            ->setParameter('approved', DoctorApplicationStatus::APPROVED->value)
            ->getQuery();
    }

    /**
     * This email's drafts that have not expired at `$now`, most recently saved first.
     *
     * @return list<DoctorApplication>
     */
    public function liveDraftsForEmail(string $email, DateTimeImmutable $now): array
    {
        return $this->draftsForEmailQuery($email, $now)->getResult();
    }

    public function draftsForEmailQuery(string $email, DateTimeImmutable $now): Query
    {
        return $this->qb()
            ->andWhere('a.email = :email')
            ->andWhere('a.status = :draft')
            ->andWhere('a.draftExpiresAt IS NULL OR a.draftExpiresAt >= :now')
            ->setParameter('email', strtolower(trim($email)))
            ->setParameter('draft', DoctorApplicationStatus::DRAFT->value)
            ->setParameter('now', $now)
            ->orderBy('a.lastSavedAt', 'DESC')
            ->addOrderBy('a.id', 'ASC')
            ->setMaxResults(50)
            ->getQuery();
    }

    /** The draft a resume link belongs to (expiry is checked by the caller). */
    public function findDraftByResumeTokenHash(string $hash): ?DoctorApplication
    {
        return $this->qb()
            ->andWhere('a.resumeTokenHash = :hash')
            ->andWhere('a.status = :draft')
            ->setParameter('hash', $hash)
            ->setParameter('draft', DoctorApplicationStatus::DRAFT->value)
            ->setMaxResults(1)
            ->getQuery()
            ->getOneOrNullResult();
    }

    /**
     * Drafts not saved for 30 days (draft_expires_at before `$now`), oldest first.
     *
     * @return list<DoctorApplication>
     */
    public function expiredDrafts(DateTimeImmutable $now, int $limit): array
    {
        return $this->expiredDraftsQuery($now, $limit)->getResult();
    }

    public function expiredDraftsQuery(DateTimeImmutable $now, int $limit): Query
    {
        return $this->qb()
            ->andWhere('a.status = :draft')
            ->andWhere('a.draftExpiresAt IS NOT NULL')
            ->andWhere('a.draftExpiresAt < :now')
            ->setParameter('draft', DoctorApplicationStatus::DRAFT->value)
            ->setParameter('now', $now)
            ->orderBy('a.draftExpiresAt', 'ASC')
            ->setMaxResults(max(1, $limit))
            ->getQuery();
    }

    public function countExpiredDrafts(DateTimeImmutable $now): int
    {
        return (int) $this->em->createQueryBuilder()
            ->select('COUNT(a.id)')
            ->from(DoctorApplication::class, 'a')
            ->andWhere('a.status = :draft')
            ->andWhere('a.draftExpiresAt IS NOT NULL')
            ->andWhere('a.draftExpiresAt < :now')
            ->setParameter('draft', DoctorApplicationStatus::DRAFT->value)
            ->setParameter('now', $now)
            ->getQuery()
            ->getSingleScalarResult();
    }

    /**
     * The back office's list (spec §3.3.1): never drafts. `needs_action` = open
     * and waiting on staff, or an interview an hour past its start still
     * undecided (epoch compare against a PHP-bound now).
     */
    public function adminListQuery(?string $q, string $filter, ?string $route, string $sort, int $nowEpoch): QueryBuilder
    {
        $qb = $this->qb()->andWhere('a.status <> :draft')->setParameter('draft', DoctorApplicationStatus::DRAFT->value);

        if ($filter === 'needs_action') {
            $this->needsAction($qb, $nowEpoch);
        } elseif ($filter !== 'all' && in_array($filter, self::FILTERS, true)) {
            $qb->andWhere('a.status = :status')->setParameter('status', $filter);
        }
        if ($route === 'ng' || $route === 'abroad') {
            $qb->andWhere('a.licenceRoute = :route')->setParameter('route', $route);
        }

        $q = $q !== null ? trim($q) : '';
        if ($q !== '') {
            $like = '%' . addcslashes(mb_strtolower($q), '%_\\') . '%';
            $or   = $qb->expr()->orX(
                'LOWER(a.firstName) LIKE :q',
                'LOWER(a.lastName) LIKE :q',
                'LOWER(CONCAT(CONCAT(a.firstName, :space), a.lastName)) LIKE :q', // a bound space: DQL string literals need a live connection to quote
                'a.email LIKE :q',
                'LOWER(a.reference) LIKE :q',
                'LOWER(a.mdcnNumber) LIKE :q',
                'LOWER(a.registrationNumber) LIKE :q',
            );
            $digits = (string) preg_replace('/\D+/', '', $q);
            if (strlen($digits) >= 4) {
                $or->add('a.phone LIKE :digits');
                $qb->setParameter('digits', '%' . $digits . '%');
            }
            $qb->andWhere($or)->setParameter('q', $like)->setParameter('space', ' ');
        }

        match ($sort) {
            'waiting'   => $qb->addSelect('COALESCE(a.lastApplicantReplyAt, a.submittedAt) AS HIDDEN waitingSince')
                ->orderBy('waitingSince', 'ASC'),
            'interview' => $qb->addSelect('CASE WHEN a.interviewEpoch IS NULL THEN 1 ELSE 0 END AS HIDDEN noInterview')
                ->orderBy('noInterview', 'ASC')
                ->addOrderBy('a.interviewEpoch', 'ASC'),
            default     => $qb->orderBy('a.submittedAt', 'DESC'),
        };

        return $qb->addOrderBy('a.id', 'ASC');
    }

    /**
     * One page of {@see adminListQuery()} and the total.
     *
     * @return array{items: list<DoctorApplication>, total: int}
     */
    public function adminPage(?string $q, string $filter, ?string $route, string $sort, int $nowEpoch, int $offset, int $perPage): array
    {
        $count = $this->adminListQuery($q, $filter, $route, 'newest', $nowEpoch)
            ->select('COUNT(a.id)')
            ->resetDQLPart('orderBy');
        $total = (int) $count->getQuery()->getSingleScalarResult();
        $items = $this->adminListQuery($q, $filter, $route, $sort, $nowEpoch)
            ->setFirstResult(max(0, $offset))
            ->setMaxResults(max(1, $perPage))
            ->getQuery()
            ->getResult();

        return ['items' => array_values(array_filter($items, static fn (mixed $a): bool => $a instanceof DoctorApplication)), 'total' => $total];
    }

    /**
     * The badge and the filter counts (spec §3.3.2) in one row: needs_action,
     * each open status, and interviews today (epoch bounds of today's clinic
     * date). Not cached.
     */
    public function queueCountsQuery(int $nowEpoch, int $dayStartEpoch, int $dayEndEpoch): Query
    {
        return $this->em->createQueryBuilder()
            ->select(
                'SUM(CASE WHEN a.awaitingStaff = true OR (a.status = :iv AND a.interviewEpoch < :cutoff) THEN 1 ELSE 0 END) AS needs_action',
                'SUM(CASE WHEN a.status = :submitted THEN 1 ELSE 0 END) AS submitted',
                'SUM(CASE WHEN a.status = :review THEN 1 ELSE 0 END) AS under_review',
                'SUM(CASE WHEN a.status = :info THEN 1 ELSE 0 END) AS more_info_needed',
                'SUM(CASE WHEN a.status = :iv THEN 1 ELSE 0 END) AS interview_scheduled',
                'SUM(CASE WHEN a.status = :iv AND a.interviewEpoch >= :dayStart AND a.interviewEpoch < :dayEnd THEN 1 ELSE 0 END) AS interviews_today',
            )
            ->from(DoctorApplication::class, 'a')
            ->andWhere('a.status IN (:open)')
            ->setParameter('open', DoctorApplicationStatus::OPEN)
            ->setParameter('iv', DoctorApplicationStatus::INTERVIEW_SCHEDULED->value)
            ->setParameter('submitted', DoctorApplicationStatus::SUBMITTED->value)
            ->setParameter('review', DoctorApplicationStatus::UNDER_REVIEW->value)
            ->setParameter('info', DoctorApplicationStatus::MORE_INFO_NEEDED->value)
            ->setParameter('cutoff', $nowEpoch - self::INTERVIEW_GRACE_SECONDS)
            ->setParameter('dayStart', $dayStartEpoch)
            ->setParameter('dayEnd', $dayEndEpoch)
            ->getQuery();
    }

    /** @return array{needs_action:int, submitted:int, under_review:int, more_info_needed:int, interview_scheduled:int, interviews_today:int} */
    public function queueCounts(int $nowEpoch, int $dayStartEpoch, int $dayEndEpoch): array
    {
        $row = $this->queueCountsQuery($nowEpoch, $dayStartEpoch, $dayEndEpoch)->getSingleResult();
        $out = [];
        foreach (['needs_action', 'submitted', 'under_review', 'more_info_needed', 'interview_scheduled', 'interviews_today'] as $key) {
            $out[$key] = (int) ($row[$key] ?? 0);
        }

        return $out;
    }

    /** The open applications waiting on a reviewer (the dashboard item). */
    public function countNeedsAction(int $nowEpoch): int
    {
        $qb = $this->em->createQueryBuilder()->select('COUNT(a.id)')->from(DoctorApplication::class, 'a');
        $this->needsAction($qb, $nowEpoch);

        return (int) $qb->getQuery()->getSingleScalarResult();
    }

    private function needsAction(QueryBuilder $qb, int $nowEpoch): void
    {
        $qb->andWhere('a.status IN (:open)')
            ->andWhere('a.awaitingStaff = true OR (a.status = :iv AND a.interviewEpoch < :cutoff)')
            ->setParameter('open', DoctorApplicationStatus::OPEN)
            ->setParameter('iv', DoctorApplicationStatus::INTERVIEW_SCHEDULED->value)
            ->setParameter('cutoff', $nowEpoch - self::INTERVIEW_GRACE_SECONDS);
    }

    public static function isUuid(string $id): bool
    {
        return preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i', $id) === 1;
    }
}
