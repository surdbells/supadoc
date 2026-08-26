<?php

declare(strict_types=1);

namespace App\Domain\Repository;

use App\Domain\Entity\Referral;

final class ReferralRepository extends BaseRepository
{
    protected function getEntityClass(): string
    {
        return Referral::class;
    }

    /**
     * A consultation's referrals, newest first.
     *
     * @return list<Referral>
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
