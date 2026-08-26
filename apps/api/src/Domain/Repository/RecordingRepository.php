<?php

declare(strict_types=1);

namespace App\Domain\Repository;

use App\Domain\Entity\Recording;

final class RecordingRepository extends BaseRepository
{
    protected function getEntityClass(): string
    {
        return Recording::class;
    }

    /**
     * A consultation's recordings, newest first.
     *
     * @return list<Recording>
     */
    public function forAppointment(string $appointmentId): array
    {
        return $this->qb()
            ->andWhere('e.appointmentId = :appointment')
            ->setParameter('appointment', $appointmentId)
            ->orderBy('e.startedAt', 'DESC')
            ->getQuery()
            ->getResult();
    }

    /** Count of recordings currently in progress across the platform. */
    public function countActive(): int
    {
        return (int) $this->em->createQueryBuilder()
            ->select('COUNT(e.id)')
            ->from(Recording::class, 'e')
            ->andWhere('e.status = :recording')
            ->setParameter('recording', Recording::STATUS_RECORDING)
            ->getQuery()
            ->getSingleScalarResult();
    }

    /**
     * Appointment ids that have a recording in progress right now.
     *
     * @return list<string>
     */
    public function activeAppointmentIds(): array
    {
        $rows = $this->em->createQueryBuilder()
            ->select('DISTINCT e.appointmentId AS aid')
            ->from(Recording::class, 'e')
            ->andWhere('e.status = :recording')
            ->setParameter('recording', Recording::STATUS_RECORDING)
            ->getQuery()
            ->getScalarResult();

        return array_map(static fn (array $r): string => (string) $r['aid'], $rows);
    }

    /**
     * The most recent recordings across the platform, newest first.
     *
     * @return list<Recording>
     */
    public function recent(int $limit = 50): array
    {
        return $this->qb()
            ->orderBy('e.startedAt', 'DESC')
            ->setMaxResults($limit)
            ->getQuery()
            ->getResult();
    }

    /** The currently-active recording for a consultation, if any. */
    public function activeForAppointment(string $appointmentId): ?Recording
    {
        return $this->qb()
            ->andWhere('e.appointmentId = :appointment')
            ->andWhere('e.status = :recording')
            ->setParameter('appointment', $appointmentId)
            ->setParameter('recording', Recording::STATUS_RECORDING)
            ->orderBy('e.startedAt', 'DESC')
            ->setMaxResults(1)
            ->getQuery()
            ->getOneOrNullResult();
    }
}
