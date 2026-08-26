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
