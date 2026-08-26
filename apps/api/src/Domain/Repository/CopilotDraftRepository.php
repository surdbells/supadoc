<?php

declare(strict_types=1);

namespace App\Domain\Repository;

use App\Domain\Entity\CopilotDraft;

final class CopilotDraftRepository extends BaseRepository
{
    protected function getEntityClass(): string
    {
        return CopilotDraft::class;
    }

    /** The consultation's AI draft (one per appointment), or null if none yet. */
    public function findByAppointment(string $appointmentId): ?CopilotDraft
    {
        return $this->qb()
            ->andWhere('e.appointmentId = :appointment')
            ->setParameter('appointment', $appointmentId)
            ->getQuery()
            ->getOneOrNullResult();
    }
}
