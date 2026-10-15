<?php

declare(strict_types=1);

namespace App\Domain\Repository;

use App\Domain\Entity\AvailabilitySlot;
use App\Domain\Enum\SlotKind;
use DateTimeImmutable;
use Doctrine\ORM\Query;

final class AvailabilitySlotRepository extends BaseRepository
{
    protected function getEntityClass(): string
    {
        return AvailabilitySlot::class;
    }

    /**
     * Every slot (open + block) that starts within [from, to), soonest first —
     * the doctor's calendar window and the source data for availability.
     *
     * @return list<AvailabilitySlot>
     */
    public function forSpecialistBetween(
        string $specialistId,
        DateTimeImmutable $from,
        DateTimeImmutable $to,
    ): array {
        return $this->qb()
            ->andWhere('e.specialist = :specialist')
            ->andWhere('e.startsAt >= :from')
            ->andWhere('e.startsAt < :to')
            ->setParameter('specialist', $specialistId)
            ->setParameter('from', $from)
            ->setParameter('to', $to)
            ->orderBy('e.startsAt', 'ASC')
            ->getQuery()
            ->getResult();
    }

    /** A single slot, but only if it belongs to the given specialist. */
    public function findForSpecialist(string $id, string $specialistId): ?AvailabilitySlot
    {
        return $this->qb()
            ->andWhere('e.id = :id')
            ->andWhere('e.specialist = :specialist')
            ->setParameter('id', $id)
            ->setParameter('specialist', $specialistId)
            ->getQuery()
            ->getOneOrNullResult();
    }

    /**
     * Does the specialist publish any OPEN slots in [$from, $to)? When true, the
     * explicit slots are the source of truth for availability in that window (the
     * recurring weekly grid is no longer used for that specialist).
     *
     * $to MUST match the window the caller actually generates/scans; leaving it
     * open (null) risks switching a specialist to explicit mode on the strength
     * of a far-future slot that the generation window never reaches — which would
     * silently zero their near-term availability.
     */
    public function hasOpenSlotsSince(
        string $specialistId,
        DateTimeImmutable $from,
        ?DateTimeImmutable $to = null,
    ): bool {
        $qb = $this->em->createQueryBuilder()
            ->select('COUNT(e.id)')
            ->from(AvailabilitySlot::class, 'e')
            ->andWhere('e.specialist = :specialist')
            ->andWhere('e.kind = :open')
            ->andWhere('e.startsAt >= :from')
            ->setParameter('specialist', $specialistId)
            ->setParameter('open', SlotKind::OPEN->value)
            ->setParameter('from', $from);

        if ($to !== null) {
            $qb->andWhere('e.startsAt < :to')->setParameter('to', $to);
        }

        return (int) $qb->getQuery()->getSingleScalarResult() > 0;
    }

    // ----- Batched availability (any number of doctors, one query each) -----
    // Each finder has a public *Query() twin so its DQL compiles in the offline tests.

    /**
     * The open slots and blocks of several specialists that start in [from, to),
     * as plain rows — no entities, and never a block's reason. The source data
     * for {@see \App\Infrastructure\Service\AvailabilityService}.
     *
     * @param list<string> $specialistIds
     * @return list<array{specialist_id:string, starts_at:mixed, ends_at:mixed, kind:mixed}>
     */
    public function rowsForSpecialistsBetween(array $specialistIds, DateTimeImmutable $from, DateTimeImmutable $to): array
    {
        if ($specialistIds === []) {
            return [];
        }

        return $this->rowsForSpecialistsBetweenQuery($specialistIds, $from, $to)->getArrayResult();
    }

    /** @param list<string> $specialistIds */
    public function rowsForSpecialistsBetweenQuery(array $specialistIds, DateTimeImmutable $from, DateTimeImmutable $to): Query
    {
        return $this->em->createQueryBuilder()
            ->select('IDENTITY(e.specialist) AS specialist_id', 'e.startsAt AS starts_at', 'e.endsAt AS ends_at', 'e.kind AS kind')
            ->from(AvailabilitySlot::class, 'e')
            ->andWhere('e.specialist IN (:ids)')
            ->andWhere('e.startsAt >= :from')
            ->andWhere('e.startsAt < :to')
            ->setParameter('ids', $specialistIds)
            ->setParameter('from', $from)
            ->setParameter('to', $to)
            ->orderBy('e.startsAt', 'ASC')
            ->getQuery();
    }

    /**
     * Which of these specialists publish an OPEN slot starting in [from, to)?
     * (A doctor with no weekly hours only gets the weekday default when they
     * publish nothing in the booking window.)
     *
     * @param list<string> $specialistIds
     * @return array<string,true> specialist id => true
     */
    public function specialistIdsWithOpenSlots(array $specialistIds, DateTimeImmutable $from, DateTimeImmutable $to): array
    {
        if ($specialistIds === []) {
            return [];
        }
        $out = [];
        foreach ($this->specialistIdsWithOpenSlotsQuery($specialistIds, $from, $to)->getScalarResult() as $row) {
            $out[(string) $row['specialist_id']] = true;
        }

        return $out;
    }

    /** @param list<string> $specialistIds */
    public function specialistIdsWithOpenSlotsQuery(array $specialistIds, DateTimeImmutable $from, DateTimeImmutable $to): Query
    {
        return $this->em->createQueryBuilder()
            ->select('DISTINCT IDENTITY(e.specialist) AS specialist_id')
            ->from(AvailabilitySlot::class, 'e')
            ->andWhere('e.specialist IN (:ids)')
            ->andWhere('e.kind = :open')
            ->andWhere('e.startsAt >= :from')
            ->andWhere('e.startsAt < :to')
            ->setParameter('ids', $specialistIds)
            ->setParameter('open', SlotKind::OPEN->value)
            ->setParameter('from', $from)
            ->setParameter('to', $to)
            ->getQuery();
    }
}
