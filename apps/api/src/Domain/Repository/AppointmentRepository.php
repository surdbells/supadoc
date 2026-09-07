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
     * Appointment counts grouped by status (for the admin monitoring overview).
     *
     * @return array<string, int>
     */
    public function statusCounts(): array
    {
        $rows = $this->em->createQueryBuilder()
            ->select('e.status AS status, COUNT(e.id) AS c')
            ->from(Appointment::class, 'e')
            ->andWhere('e.deletedAt IS NULL')
            ->groupBy('e.status')
            ->getQuery()
            ->getScalarResult();

        $out = [];
        foreach ($rows as $row) {
            // DQL returns the enum's backing value for a scalar select.
            $status       = $row['status'] instanceof AppointmentStatus ? $row['status']->value : (string) $row['status'];
            $out[$status] = (int) $row['c'];
        }

        return $out;
    }

    /**
     * Lightweight rows for analytics, over a booking-date window. Returns scalar
     * fields only (no hydration) so a wide range stays cheap; aggregation into
     * time-series/top-lists happens in PHP (DB-portable, no vendor date funcs).
     *
     * @return list<array{created_at: DateTimeImmutable, amount: string, payment_status: string, status: string, type: string, specialist_id: string, specialist_name: string}>
     */
    public function analyticsRows(DateTimeImmutable $from, DateTimeImmutable $to): array
    {
        $rows = $this->em->createQueryBuilder()
            ->select(
                'e.createdAt AS created_at',
                'e.amount AS amount',
                'e.paymentStatus AS payment_status',
                'e.status AS status',
                'e.type AS type',
                's.id AS specialist_id',
                's.name AS specialist_name',
            )
            ->from(Appointment::class, 'e')
            ->join('e.specialist', 's')
            ->andWhere('e.deletedAt IS NULL')
            ->andWhere('e.createdAt >= :from')
            ->andWhere('e.createdAt <= :to')
            ->setParameter('from', $from)
            ->setParameter('to', $to)
            ->getQuery()
            ->getArrayResult();

        return array_map(static function (array $r): array {
            $status = $r['status'] ?? '';
            $type   = $r['type'] ?? '';

            return [
                'created_at'     => $r['created_at'],
                'amount'         => (string) ($r['amount'] ?? '0.00'),
                'payment_status' => (string) ($r['payment_status'] ?? ''),
                'status'         => is_object($status) ? $status->value : (string) $status,
                'type'           => is_object($type) ? $type->value : (string) $type,
                'specialist_id'  => (string) ($r['specialist_id'] ?? ''),
                'specialist_name' => (string) ($r['specialist_name'] ?? ''),
            ];
        }, $rows);
    }

    /**
     * The most recent appointments (non-deleted), newest first — the monitoring list.
     *
     * @return array{items: list<Appointment>, total: int}
     */
    public function recent(int $offset, int $perPage): array
    {
        return $this->paginatedQuery(
            $this->qb()->andWhere('e.deletedAt IS NULL'),
            $this->alias(),
            $offset,
            $perPage,
            'scheduledAt',
            'desc',
        );
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
     * All of a specialist's appointments (non-deleted), soonest first — the
     * minimal doctor portal's schedule.
     *
     * @return list<Appointment>
     */
    public function forSpecialist(string $specialistId, int $limit = 100): array
    {
        return $this->qb()
            ->andWhere('e.specialist = :specialist')
            ->andWhere('e.deletedAt IS NULL')
            ->setParameter('specialist', $specialistId)
            ->orderBy('e.scheduledAt', 'ASC')
            ->setMaxResults($limit)
            ->getQuery()
            ->getResult();
    }

    /**
     * Upcoming, still-active appointments whose start falls in [from, to) —
     * the reminder cron's due window. Excludes cancelled and completed bookings.
     *
     * @return list<Appointment>
     */
    public function dueForReminder(DateTimeImmutable $from, DateTimeImmutable $to): array
    {
        return $this->qb()
            ->andWhere('e.scheduledAt >= :from')
            ->andWhere('e.scheduledAt < :to')
            ->andWhere('e.status NOT IN (:done)')
            ->andWhere('e.deletedAt IS NULL')
            ->setParameter('from', $from)
            ->setParameter('to', $to)
            ->setParameter('done', [
                AppointmentStatus::CANCELLED->value,
                AppointmentStatus::COMPLETED->value,
            ])
            ->orderBy('e.scheduledAt', 'ASC')
            ->getQuery()
            ->getResult();
    }

    /**
     * Count a specialist's appointments, optionally filtered by status and a
     * [from, to) window (either bound optional).
     *
     * @param list<AppointmentStatus>|null $statuses
     */
    public function countForSpecialist(
        string $specialistId,
        ?array $statuses = null,
        ?DateTimeImmutable $from = null,
        ?DateTimeImmutable $to = null,
    ): int {
        $qb = $this->em->createQueryBuilder()
            ->select('COUNT(e.id)')
            ->from(Appointment::class, 'e')
            ->andWhere('e.specialist = :specialist')
            ->andWhere('e.deletedAt IS NULL')
            ->setParameter('specialist', $specialistId);
        $this->applyStatusWindow($qb, $statuses, $from, $to);

        return (int) $qb->getQuery()->getSingleScalarResult();
    }

    /**
     * Sum of the `amount` of a specialist's appointments in the given statuses /
     * window (money-as-string, scale 2). Used for the earnings snapshot.
     *
     * @param list<AppointmentStatus> $statuses
     */
    public function sumAmountForSpecialist(
        string $specialistId,
        array $statuses,
        ?DateTimeImmutable $from = null,
        ?DateTimeImmutable $to = null,
    ): string {
        $qb = $this->em->createQueryBuilder()
            ->select('COALESCE(SUM(e.amount), 0)')
            ->from(Appointment::class, 'e')
            ->andWhere('e.specialist = :specialist')
            ->andWhere('e.deletedAt IS NULL')
            ->setParameter('specialist', $specialistId);
        $this->applyStatusWindow($qb, $statuses, $from, $to);

        return number_format((float) $qb->getQuery()->getSingleScalarResult(), 2, '.', '');
    }

    /** Does this specialist have any appointment with the given patient? */
    public function hasAppointmentWith(string $specialistId, string $patientId): bool
    {
        $count = (int) $this->em->createQueryBuilder()
            ->select('COUNT(e.id)')
            ->from(Appointment::class, 'e')
            ->andWhere('e.specialist = :specialist')
            ->andWhere('e.patient = :patient')
            ->andWhere('e.deletedAt IS NULL')
            ->setParameter('specialist', $specialistId)
            ->setParameter('patient', $patientId)
            ->getQuery()
            ->getSingleScalarResult();

        return $count > 0;
    }

    /** A specialist's appointments with one patient, newest first. @return list<Appointment> */
    public function forSpecialistAndPatient(string $specialistId, string $patientId): array
    {
        return $this->qb()
            ->andWhere('e.specialist = :specialist')
            ->andWhere('e.patient = :patient')
            ->andWhere('e.deletedAt IS NULL')
            ->setParameter('specialist', $specialistId)
            ->setParameter('patient', $patientId)
            ->orderBy('e.scheduledAt', 'DESC')
            ->getQuery()
            ->getResult();
    }

    /**
     * A specialist's patients (one row per patient) with visit count + last
     * visit, newest-visit first, paginated with optional name/email search.
     *
     * @return array{items: list<array<string,mixed>>, total: int}
     */
    public function patientsForSpecialist(
        int $offset,
        int $perPage,
        string $specialistId,
        ?string $search = null,
    ): array {
        $applySearch = $search !== null && trim($search) !== '';
        $like        = $applySearch ? '%' . strtolower(trim($search)) . '%' : null;
        $searchExpr  = "(LOWER(CONCAT(p.firstName, ' ', p.lastName)) LIKE :q OR LOWER(p.email) LIKE :q)";

        $countQb = $this->em->createQueryBuilder()
            ->select('COUNT(DISTINCT e.patient)')
            ->from(Appointment::class, 'e')
            ->join('e.patient', 'p')
            ->andWhere('e.specialist = :specialist')
            ->andWhere('e.deletedAt IS NULL')
            ->setParameter('specialist', $specialistId);
        if ($applySearch) {
            $countQb->andWhere($searchExpr)->setParameter('q', $like);
        }
        $total = (int) $countQb->getQuery()->getSingleScalarResult();

        $qb = $this->em->createQueryBuilder()
            ->select('IDENTITY(e.patient) AS patient_id, p.firstName AS first_name, p.lastName AS last_name, p.email AS email, COUNT(e.id) AS visit_count, MAX(e.scheduledAt) AS last_visit')
            ->from(Appointment::class, 'e')
            ->join('e.patient', 'p')
            ->andWhere('e.specialist = :specialist')
            ->andWhere('e.deletedAt IS NULL')
            ->groupBy('e.patient, p.firstName, p.lastName, p.email')
            ->orderBy('last_visit', 'DESC')
            ->setFirstResult(max(0, $offset))
            ->setMaxResults(max(1, $perPage))
            ->setParameter('specialist', $specialistId);
        if ($applySearch) {
            $qb->andWhere($searchExpr)->setParameter('q', $like);
        }

        return ['items' => $qb->getQuery()->getArrayResult(), 'total' => $total];
    }

    /** Distinct patients a specialist has ever had an appointment with. */
    public function distinctPatientsForSpecialist(string $specialistId): int
    {
        return (int) $this->em->createQueryBuilder()
            ->select('COUNT(DISTINCT e.patient)')
            ->from(Appointment::class, 'e')
            ->andWhere('e.specialist = :specialist')
            ->andWhere('e.deletedAt IS NULL')
            ->setParameter('specialist', $specialistId)
            ->getQuery()
            ->getSingleScalarResult();
    }

    /** The specialist's next upcoming, still-active appointment, if any. */
    public function nextForSpecialist(string $specialistId, DateTimeImmutable $now): ?Appointment
    {
        return $this->qb()
            ->andWhere('e.specialist = :specialist')
            ->andWhere('e.scheduledAt >= :now')
            ->andWhere('e.status NOT IN (:done)')
            ->andWhere('e.deletedAt IS NULL')
            ->setParameter('specialist', $specialistId)
            ->setParameter('now', $now)
            ->setParameter('done', [AppointmentStatus::CANCELLED->value, AppointmentStatus::COMPLETED->value])
            ->orderBy('e.scheduledAt', 'ASC')
            ->setMaxResults(1)
            ->getQuery()
            ->getOneOrNullResult();
    }

    /**
     * Paginated appointment history for a specialist, newest first, optionally
     * filtered by status and a patient-name search.
     *
     * @param list<AppointmentStatus>|null $statuses
     * @return array{items: list<Appointment>, total: int}
     */
    public function paginatedForSpecialist(
        int $offset,
        int $perPage,
        string $specialistId,
        ?array $statuses = null,
        ?string $search = null,
    ): array {
        $qb = $this->qb()
            ->andWhere('e.specialist = :specialist')
            ->andWhere('e.deletedAt IS NULL')
            ->setParameter('specialist', $specialistId);

        if ($statuses !== null && $statuses !== []) {
            $qb->andWhere('e.status IN (:statuses)')
                ->setParameter('statuses', array_map(static fn (AppointmentStatus $s): string => $s->value, $statuses));
        }
        if ($search !== null && trim($search) !== '') {
            $qb->join('e.patient', 'p')
                ->andWhere("LOWER(CONCAT(p.firstName, ' ', p.lastName)) LIKE :q OR LOWER(p.email) LIKE :q")
                ->setParameter('q', '%' . strtolower(trim($search)) . '%');
        }

        return $this->paginatedQuery($qb, $this->alias(), $offset, $perPage, 'scheduledAt', 'desc');
    }

    /**
     * Apply an optional status list + [from, to) window to a count/sum builder.
     *
     * @param list<AppointmentStatus>|null $statuses
     */
    private function applyStatusWindow(
        \Doctrine\ORM\QueryBuilder $qb,
        ?array $statuses,
        ?DateTimeImmutable $from,
        ?DateTimeImmutable $to,
    ): void {
        if ($statuses !== null && $statuses !== []) {
            $qb->andWhere('e.status IN (:statuses)')
                ->setParameter('statuses', array_map(static fn (AppointmentStatus $s): string => $s->value, $statuses));
        }
        if ($from !== null) {
            $qb->andWhere('e.scheduledAt >= :from')->setParameter('from', $from);
        }
        if ($to !== null) {
            $qb->andWhere('e.scheduledAt < :to')->setParameter('to', $to);
        }
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
