<?php

declare(strict_types=1);

namespace App\Domain\Repository;

use App\Domain\Entity\ConsultationConsent;

final class ConsultationConsentRepository extends BaseRepository
{
    protected function getEntityClass(): string
    {
        return ConsultationConsent::class;
    }

    /**
     * All consent decisions for a consultation.
     *
     * @return list<ConsultationConsent>
     */
    public function forAppointment(string $appointmentId): array
    {
        return $this->qb()
            ->andWhere('e.appointmentId = :appointment')
            ->setParameter('appointment', $appointmentId)
            ->getQuery()
            ->getResult();
    }

    public function findOne(string $appointmentId, string $type): ?ConsultationConsent
    {
        return $this->qb()
            ->andWhere('e.appointmentId = :appointment')
            ->andWhere('e.consentType = :type')
            ->setParameter('appointment', $appointmentId)
            ->setParameter('type', $type)
            ->getQuery()
            ->getOneOrNullResult();
    }
}
