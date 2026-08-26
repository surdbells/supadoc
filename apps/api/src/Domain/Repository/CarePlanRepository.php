<?php

declare(strict_types=1);

namespace App\Domain\Repository;

use App\Domain\Entity\CarePlan;

final class CarePlanRepository extends BaseRepository
{
    protected function getEntityClass(): string
    {
        return CarePlan::class;
    }

    /** The consultation's care plan (one per appointment), or null if none yet. */
    public function findByAppointment(string $appointmentId): ?CarePlan
    {
        return $this->qb()
            ->andWhere('e.appointmentId = :appointment')
            ->setParameter('appointment', $appointmentId)
            ->getQuery()
            ->getOneOrNullResult();
    }
}
