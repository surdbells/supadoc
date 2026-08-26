<?php

declare(strict_types=1);

namespace App\Domain\Repository;

use App\Domain\Entity\ClinicalNote;

final class ClinicalNoteRepository extends BaseRepository
{
    protected function getEntityClass(): string
    {
        return ClinicalNote::class;
    }

    /** The consultation's SOAP note, or null if the doctor hasn't started one. */
    public function findByAppointment(string $appointmentId): ?ClinicalNote
    {
        return $this->qb()
            ->andWhere('e.appointmentId = :appointment')
            ->setParameter('appointment', $appointmentId)
            ->getQuery()
            ->getOneOrNullResult();
    }
}
