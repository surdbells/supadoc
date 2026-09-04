<?php

declare(strict_types=1);

namespace App\Domain\Repository;

use App\Domain\Entity\AppointmentReminder;

final class AppointmentReminderRepository extends BaseRepository
{
    protected function getEntityClass(): string
    {
        return AppointmentReminder::class;
    }

    /** Has the reminder for this appointment + offset already been sent? */
    public function wasSent(string $appointmentId, int $offsetMinutes): bool
    {
        $count = (int) $this->em->createQueryBuilder()
            ->select('COUNT(e.id)')
            ->from(AppointmentReminder::class, 'e')
            ->andWhere('e.appointmentId = :appointment')
            ->andWhere('e.offsetMinutes = :offset')
            ->setParameter('appointment', $appointmentId)
            ->setParameter('offset', $offsetMinutes)
            ->getQuery()
            ->getSingleScalarResult();

        return $count > 0;
    }

    /** Record that the reminder for this appointment + offset was sent. */
    public function markSent(string $appointmentId, int $offsetMinutes): void
    {
        $this->save(new AppointmentReminder($appointmentId, $offsetMinutes));
    }
}
