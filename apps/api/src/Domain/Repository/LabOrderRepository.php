<?php

declare(strict_types=1);

namespace App\Domain\Repository;

use App\Domain\Entity\LabOrder;

final class LabOrderRepository extends BaseRepository
{
    protected function getEntityClass(): string
    {
        return LabOrder::class;
    }

    /**
     * A consultation's lab orders, newest first.
     *
     * @return list<LabOrder>
     */
    public function forAppointment(string $appointmentId): array
    {
        return $this->qb()
            ->andWhere('e.appointmentId = :appointment')
            ->setParameter('appointment', $appointmentId)
            ->orderBy('e.createdAt', 'DESC')
            ->getQuery()
            ->getResult();
    }
}
