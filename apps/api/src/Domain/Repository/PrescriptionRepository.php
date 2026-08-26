<?php

declare(strict_types=1);

namespace App\Domain\Repository;

use App\Domain\Entity\Prescription;

final class PrescriptionRepository extends BaseRepository
{
    protected function getEntityClass(): string
    {
        return Prescription::class;
    }

    /**
     * A consultation's prescriptions, newest first. Pass $signedOnly for the
     * patient view — a draft the doctor is still building is never exposed.
     *
     * @return list<Prescription>
     */
    public function forAppointment(string $appointmentId, bool $signedOnly = false): array
    {
        $qb = $this->qb()
            ->andWhere('e.appointmentId = :appointment')
            ->setParameter('appointment', $appointmentId)
            ->orderBy('e.createdAt', 'DESC');

        if ($signedOnly) {
            $qb->andWhere('e.status = :signed')->setParameter('signed', Prescription::STATUS_SIGNED);
        }

        return $qb->getQuery()->getResult();
    }
}
