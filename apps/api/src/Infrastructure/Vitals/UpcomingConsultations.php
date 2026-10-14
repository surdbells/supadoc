<?php

declare(strict_types=1);

namespace App\Infrastructure\Vitals;

use App\Domain\Entity\Appointment;
use App\Domain\Enum\AppointmentStatus;
use DateTimeImmutable;
use DateTimeZone;
use Doctrine\ORM\EntityManagerInterface;
use Doctrine\ORM\QueryBuilder;

/**
 * The patient's consultations starting soon — what the vitals reminder's
 * "upcoming" reason looks at ({@see VitalsService::reminder()}). Still-active
 * bookings only (pending, confirmed or rescheduled), the same rule the join
 * reminder emails use.
 */
final class UpcomingConsultations
{
    /** More than enough for a 48-hour window. */
    private const LIMIT = 20;

    public function __construct(private readonly EntityManagerInterface $em)
    {
    }

    /**
     * Soonest first, starting in [now, now + hours].
     *
     * @return list<array{id: string, scheduled_at: DateTimeImmutable}>
     */
    public function startingWithin(string $patientId, DateTimeImmutable $now, int $hours = VitalsService::UPCOMING_WITHIN_HOURS): array
    {
        /** @var list<Appointment> $rows */
        $rows = $this->query($patientId, $now, $now->modify(sprintf('+%d hours', $hours)))
            ->getQuery()
            ->getResult();

        return array_map(
            static fn (Appointment $a): array => ['id' => $a->getId(), 'scheduled_at' => $a->getScheduledAt()],
            $rows,
        );
    }

    /** The query on its own (unit-tested offline: it must compile to SQL). */
    public function query(string $patientId, DateTimeImmutable $from, DateTimeImmutable $to): QueryBuilder
    {
        // Stored without an offset in the server's zone — compare in that zone.
        $zone = new DateTimeZone(date_default_timezone_get());
        $from = $from->setTimezone($zone);
        $to   = $to->setTimezone($zone);

        return $this->em->createQueryBuilder()
            ->select('a')
            ->from(Appointment::class, 'a')
            ->andWhere('a.patient = :patient')
            ->andWhere('a.scheduledAt >= :from')
            ->andWhere('a.scheduledAt <= :to')
            ->andWhere('a.status IN (:active)')
            ->andWhere('a.deletedAt IS NULL')
            ->setParameter('patient', $patientId)
            ->setParameter('from', $from)
            ->setParameter('to', $to)
            // DQL params take the raw backed value, not the enum (ARCHITECTURE §11).
            ->setParameter('active', [
                AppointmentStatus::PENDING->value,
                AppointmentStatus::CONFIRMED->value,
                AppointmentStatus::RESCHEDULED->value,
            ])
            ->orderBy('a.scheduledAt', 'ASC')
            ->setMaxResults(self::LIMIT);
    }
}
