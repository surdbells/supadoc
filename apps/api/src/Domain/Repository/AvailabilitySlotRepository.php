<?php

declare(strict_types=1);

namespace App\Domain\Repository;

use App\Domain\Entity\AvailabilitySlot;
use App\Domain\Enum\SlotKind;
use DateTimeImmutable;

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
     * Does the specialist publish any OPEN slots at/after $from? When true, the
     * explicit slots are the source of truth for availability (the recurring
     * weekly grid is no longer used for that specialist).
     */
    public function hasOpenSlotsSince(string $specialistId, DateTimeImmutable $from): bool
    {
        return (int) $this->em->createQueryBuilder()
            ->select('COUNT(e.id)')
            ->from(AvailabilitySlot::class, 'e')
            ->andWhere('e.specialist = :specialist')
            ->andWhere('e.kind = :open')
            ->andWhere('e.startsAt >= :from')
            ->setParameter('specialist', $specialistId)
            ->setParameter('open', SlotKind::OPEN->value)
            ->setParameter('from', $from)
            ->getQuery()
            ->getSingleScalarResult() > 0;
    }

    /** True if an OPEN slot with this exact start exists for the specialist. */
    public function openSlotStartsAt(string $specialistId, DateTimeImmutable $when): bool
    {
        return (int) $this->em->createQueryBuilder()
            ->select('COUNT(e.id)')
            ->from(AvailabilitySlot::class, 'e')
            ->andWhere('e.specialist = :specialist')
            ->andWhere('e.kind = :open')
            ->andWhere('e.startsAt = :when')
            ->setParameter('specialist', $specialistId)
            ->setParameter('open', SlotKind::OPEN->value)
            ->setParameter('when', $when)
            ->getQuery()
            ->getSingleScalarResult() > 0;
    }
}
