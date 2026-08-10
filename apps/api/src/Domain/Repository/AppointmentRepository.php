<?php

declare(strict_types=1);

namespace App\Domain\Repository;

use App\Domain\Entity\Appointment;
use App\Domain\Enum\AppointmentStatus;
use DateTimeImmutable;

final class AppointmentRepository extends BaseRepository
{
    protected function getEntityClass(): string
    {
        return Appointment::class;
    }

    /**
     * @param list<AppointmentStatus>|null $statuses
     * @return array{items: list<Appointment>, total: int}
     */
    public function paginated(
        int $offset,
        int $perPage,
        string $sortBy = 'createdAt',
        string $sortDir = 'desc',
        ?string $patientId = null,
        ?array $statuses = null,
    ): array {
        $qb = $this->qb()->andWhere('e.deletedAt IS NULL');

        if ($patientId !== null) {
            $qb->andWhere('e.patient = :patient')->setParameter('patient', $patientId);
        }
        if ($statuses !== null && $statuses !== []) {
            // DQL params take the raw backed value, not the enum (ARCHITECTURE §11).
            $qb->andWhere('e.status IN (:statuses)')
                ->setParameter('statuses', array_map(
                    static fn (AppointmentStatus $s): string => $s->value,
                    $statuses,
                ));
        }

        return $this->paginatedQuery($qb, $this->alias(), $offset, $perPage, $sortBy, $sortDir);
    }

    /**
     * One appointment, but only if it belongs to the given patient — the portal
     * scopes reads so a customer can never fetch someone else's record.
     */
    public function findForPatient(string $id, string $patientId): ?Appointment
    {
        return $this->qb()
            ->andWhere('e.id = :id')
            ->andWhere('e.patient = :patient')
            ->andWhere('e.deletedAt IS NULL')
            ->setParameter('id', $id)
            ->setParameter('patient', $patientId)
            ->getQuery()
            ->getOneOrNullResult();
    }

    /**
     * Live (non-cancelled) appointments for a specialist within [from, to) —
     * used to subtract already-taken slots from generated availability.
     *
     * @return list<Appointment>
     */
    public function forSpecialistBetween(
        string $specialistId,
        DateTimeImmutable $from,
        DateTimeImmutable $to,
    ): array {
        return $this->qb()
            ->andWhere('e.specialist = :specialist')
            ->andWhere('e.scheduledAt >= :from')
            ->andWhere('e.scheduledAt < :to')
            ->andWhere('e.status != :cancelled')
            ->andWhere('e.deletedAt IS NULL')
            ->setParameter('specialist', $specialistId)
            ->setParameter('from', $from)
            ->setParameter('to', $to)
            ->setParameter('cancelled', AppointmentStatus::CANCELLED->value)
            ->getQuery()
            ->getResult();
    }
}
