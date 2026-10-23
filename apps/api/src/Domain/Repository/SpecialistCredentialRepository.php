<?php

declare(strict_types=1);

namespace App\Domain\Repository;

use App\Domain\Entity\Specialist;
use App\Domain\Entity\SpecialistCredential;
use App\Domain\Enum\SpecialistStatus;
use DateTimeImmutable;
use Doctrine\ORM\Query;

final class SpecialistCredentialRepository extends BaseRepository
{
    protected function getEntityClass(): string
    {
        return SpecialistCredential::class;
    }

    /** Whether documents can still be saved (false once a failed transaction closed the entity manager). */
    public function isWritable(): bool
    {
        return $this->em->isOpen();
    }

    /**
     * A doctor's documents, newest first (every status).
     *
     * @return list<SpecialistCredential>
     */
    public function forSpecialist(string $specialistId): array
    {
        return $this->forSpecialistQuery($specialistId)->getResult();
    }

    public function forSpecialistQuery(string $specialistId): Query
    {
        return $this->qb()
            ->andWhere('e.specialistId = :specialist')
            ->setParameter('specialist', $specialistId)
            ->orderBy('e.createdAt', 'DESC')
            ->addOrderBy('e.id', 'DESC')
            ->getQuery();
    }

    /** One document, only if it belongs to this doctor. */
    public function findForSpecialist(string $id, string $specialistId): ?SpecialistCredential
    {
        if (preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i', $id) !== 1) {
            return null; // not a uuid — Postgres would refuse the comparison
        }

        return $this->qb()
            ->andWhere('e.id = :id')
            ->andWhere('e.specialistId = :specialist')
            ->setParameter('id', $id)
            ->setParameter('specialist', $specialistId)
            ->getQuery()
            ->getOneOrNullResult();
    }

    /**
     * How many documents each of these doctors has waiting for verification.
     *
     * @param list<string> $specialistIds
     * @return array<string,int>
     */
    public function pendingCountsFor(array $specialistIds): array
    {
        if ($specialistIds === []) {
            return [];
        }
        $rows = $this->em->createQueryBuilder()
            ->select('e.specialistId AS sid, COUNT(e.id) AS c')
            ->from(SpecialistCredential::class, 'e')
            ->andWhere('e.specialistId IN (:ids)')
            ->andWhere('e.status = :pending')
            ->setParameter('ids', array_values($specialistIds))
            ->setParameter('pending', SpecialistCredential::STATUS_PENDING)
            ->groupBy('e.specialistId')
            ->getQuery()
            ->getScalarResult();

        $out = [];
        foreach ($rows as $row) {
            $out[(string) $row['sid']] = (int) $row['c'];
        }

        return $out;
    }

    /**
     * Documents waiting for verification from doctors who are live (approved,
     * legacy or suspended) — a new licence, say. A doctor still onboarding is
     * reviewed as a whole when they submit, so theirs aren't counted here.
     */
    public function countPendingFromLiveDoctors(): int
    {
        return (int) $this->countPendingFromLiveDoctorsQuery()->getSingleScalarResult();
    }

    public function countPendingFromLiveDoctorsQuery(): Query
    {
        return $this->em->createQueryBuilder()
            ->select('COUNT(e.id)')
            ->from(SpecialistCredential::class, 'e')
            ->join(Specialist::class, 's', 'WITH', 's.id = e.specialistId')
            ->andWhere('e.status = :pending')
            ->andWhere('s.deletedAt IS NULL')
            ->andWhere('s.status IS NULL OR s.status IN (:live)')
            ->setParameter('pending', SpecialistCredential::STATUS_PENDING)
            ->setParameter('live', [SpecialistStatus::APPROVED->value, SpecialistStatus::SUSPENDED->value])
            ->getQuery();
    }

    /** How many documents this doctor has waiting (an upload cap). */
    public function countPendingFor(string $specialistId): int
    {
        return (int) $this->em->createQueryBuilder()
            ->select('COUNT(e.id)')
            ->from(SpecialistCredential::class, 'e')
            ->andWhere('e.specialistId = :specialist')
            ->andWhere('e.status = :pending')
            ->setParameter('specialist', $specialistId)
            ->setParameter('pending', SpecialistCredential::STATUS_PENDING)
            ->getQuery()
            ->getSingleScalarResult();
    }

    /**
     * Verified practising licences whose last valid day is on or before
     * `$until` (a hydrated-date midnight) — the licence cron's reminder and
     * expiry candidates, soonest first.
     *
     * @return list<SpecialistCredential>
     */
    public function verifiedLicencesExpiringBy(DateTimeImmutable $until, int $limit = 500): array
    {
        return $this->verifiedLicencesExpiringByQuery($until, $limit)->getResult();
    }

    public function verifiedLicencesExpiringByQuery(DateTimeImmutable $until, int $limit = 500): Query
    {
        // Both kinds of practising licence: an APL, or a foreign licence abroad (spec §4.4).
        return $this->qb()
            ->andWhere('e.type IN (:licences)')
            ->andWhere('e.status = :verified')
            ->andWhere('e.expiresAt IS NOT NULL')
            ->andWhere('e.expiresAt <= :until')
            ->setParameter('licences', SpecialistCredential::LICENCE_TYPES)
            ->setParameter('verified', SpecialistCredential::STATUS_VERIFIED)
            ->setParameter('until', $until)
            ->orderBy('e.expiresAt', 'ASC')
            ->setMaxResults($limit)
            ->getQuery();
    }
}
