<?php

declare(strict_types=1);

namespace App\Domain\Repository;

use App\Domain\Entity\MedicalCertificate;

final class MedicalCertificateRepository extends BaseRepository
{
    protected function getEntityClass(): string
    {
        return MedicalCertificate::class;
    }

    /**
     * A consultation's certificates, newest first.
     *
     * @return list<MedicalCertificate>
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
