<?php

declare(strict_types=1);

namespace App\Domain\Repository;

use App\Domain\Entity\Appointment;
use App\Domain\Enum\AppointmentStatus;
use DateTimeImmutable;
use Doctrine\DBAL\LockMode;
use Doctrine\ORM\Query;

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

    /** True if a card payment reference has already been used to book. */
    public function existsByPaymentReference(string $reference): bool
    {
        return (int) $this->em->createQueryBuilder()
            ->select('COUNT(e.id)')
            ->from(Appointment::class, 'e')
            ->andWhere('e.paymentReference = :ref')
            ->setParameter('ref', $reference)
            ->getQuery()
            ->getSingleScalarResult() > 0;
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
        $rows = $this->analyticsQuery($from, $to)->getArrayResult();

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
     * {@see analyticsRows()}'s query. A follow-up proposal the patient never
     * accepted was never a booking: neither an open one nor one declined,
     * withdrawn or expired (cancelled, never paid) counts as an appointment or
     * a cancellation. (proposed_by is NULL on an ordinary booking — spelled out
     * so it isn't dropped by the NULL comparison.)
     */
    public function analyticsQuery(DateTimeImmutable $from, DateTimeImmutable $to): Query
    {
        return $this->em->createQueryBuilder()
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
            ->andWhere('e.status <> :proposed')
            ->andWhere('e.proposedBy IS NULL OR e.proposedBy <> :doctor OR e.status <> :cancelled OR e.paymentStatus <> :unpaid')
            ->setParameter('from', $from)
            ->setParameter('to', $to)
            ->setParameter('proposed', AppointmentStatus::PROPOSED->value)
            ->setParameter('doctor', 'doctor')
            ->setParameter('cancelled', AppointmentStatus::CANCELLED->value)
            ->setParameter('unpaid', 'unpaid')
            ->getQuery();
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
     * A specialist's appointments (non-deleted) for the doctor portal's
     * schedule, soonest first: the soonest `$limit` from a day ago on (so all of
     * today, whatever the doctor's timezone, and what's coming), then — if there
     * is room — the most recent earlier ones. Never the oldest `$limit` of a
     * long history (one consultation is loaded by id instead).
     *
     * @return list<Appointment>
     */
    public function forSpecialist(string $specialistId, int $limit = 100, ?DateTimeImmutable $now = null): array
    {
        $since = self::scheduleSince($now ?? new DateTimeImmutable());
        /** @var list<Appointment> $coming */
        $coming = $this->scheduleQuery($specialistId, $since, true, $limit)->getResult();
        $room   = $limit - count($coming);
        if ($room <= 0) {
            return $coming;
        }
        /** @var list<Appointment> $earlier newest first */
        $earlier = $this->scheduleQuery($specialistId, $since, false, $room)->getResult();

        return [...array_reverse($earlier), ...$coming];
    }

    /** Where the schedule's "from now on" part starts: a day back, so the doctor's whole today is in it. */
    public static function scheduleSince(DateTimeImmutable $now): DateTimeImmutable
    {
        return $now->modify('-1 day');
    }

    /**
     * {@see forSpecialist()}'s two halves: from `$since` on, soonest first
     * (`$coming`), or before it, newest first.
     */
    public function scheduleQuery(string $specialistId, DateTimeImmutable $since, bool $coming, int $limit): Query
    {
        return $this->qb()
            ->andWhere('e.specialist = :specialist')
            ->andWhere($coming ? 'e.scheduledAt >= :since' : 'e.scheduledAt < :since')
            ->andWhere('e.deletedAt IS NULL')
            ->setParameter('specialist', $specialistId)
            ->setParameter('since', $since)
            ->orderBy('e.scheduledAt', $coming ? 'ASC' : 'DESC')
            ->setMaxResults($limit)
            ->getQuery();
    }

    /**
     * Upcoming, still-active appointments whose start falls in [from, to) —
     * the reminder cron's due window. Excludes cancelled and completed bookings,
     * and follow-up proposals the patient hasn't accepted yet.
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
                AppointmentStatus::PROPOSED->value,
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

    /**
     * Whether the specialist has actually consulted (or is about to consult)
     * the patient: a completed appointment, or a non-cancelled one that has
     * started or starts within `$leadMinutes` (a doctor may join a call a little
     * early). A cancelled or future booking — or an unaccepted follow-up
     * proposal — is not a consultation.
     */
    public function hasConsultedWith(string $specialistId, string $patientId, DateTimeImmutable $now, int $leadMinutes = 120): bool
    {
        $count = (int) $this->em->createQueryBuilder()
            ->select('COUNT(e.id)')
            ->from(Appointment::class, 'e')
            ->andWhere('e.specialist = :specialist')
            ->andWhere('e.patient = :patient')
            ->andWhere('e.deletedAt IS NULL')
            ->andWhere('e.status = :completed OR (e.status NOT IN (:notHeld) AND e.scheduledAt <= :cutoff)')
            ->setParameter('specialist', $specialistId)
            ->setParameter('patient', $patientId)
            ->setParameter('completed', AppointmentStatus::COMPLETED)
            ->setParameter('notHeld', [AppointmentStatus::CANCELLED->value, AppointmentStatus::PROPOSED->value])
            ->setParameter('cutoff', $now->modify("+{$leadMinutes} minutes"))
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

    /**
     * Distinct patients a specialist has had an appointment with — all-time, or
     * within an optional [from, to) booking-start window (for period deltas).
     */
    public function distinctPatientsForSpecialist(
        string $specialistId,
        ?DateTimeImmutable $from = null,
        ?DateTimeImmutable $to = null,
    ): int {
        $qb = $this->em->createQueryBuilder()
            ->select('COUNT(DISTINCT e.patient)')
            ->from(Appointment::class, 'e')
            ->andWhere('e.specialist = :specialist')
            ->andWhere('e.deletedAt IS NULL')
            ->setParameter('specialist', $specialistId);
        if ($from !== null) {
            $qb->andWhere('e.scheduledAt >= :from')->setParameter('from', $from);
        }
        if ($to !== null) {
            $qb->andWhere('e.scheduledAt < :to')->setParameter('to', $to);
        }

        return (int) $qb->getQuery()->getSingleScalarResult();
    }

    /** The specialist's next upcoming, still-active appointment (not an unaccepted proposal), if any. */
    public function nextForSpecialist(string $specialistId, DateTimeImmutable $now): ?Appointment
    {
        return $this->qb()
            ->andWhere('e.specialist = :specialist')
            ->andWhere('e.scheduledAt >= :now')
            ->andWhere('e.status NOT IN (:done)')
            ->andWhere('e.deletedAt IS NULL')
            ->setParameter('specialist', $specialistId)
            ->setParameter('now', $now)
            ->setParameter('done', [AppointmentStatus::CANCELLED->value, AppointmentStatus::COMPLETED->value, AppointmentStatus::PROPOSED->value])
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
     * used to subtract already-taken slots from generated availability. An open
     * follow-up proposal holds its slot until it expires; once past its expiry
     * it no longer does, even before the cron has cancelled it.
     *
     * @return list<Appointment>
     */
    public function forSpecialistBetween(
        string $specialistId,
        DateTimeImmutable $from,
        DateTimeImmutable $to,
        ?DateTimeImmutable $now = null,
    ): array {
        return $this->forSpecialistBetweenQuery($specialistId, $from, $to, $now ?? new DateTimeImmutable())->getResult();
    }

    /** The query behind {@see forSpecialistBetween()}. */
    public function forSpecialistBetweenQuery(
        string $specialistId,
        DateTimeImmutable $from,
        DateTimeImmutable $to,
        DateTimeImmutable $now,
    ): Query {
        return $this->qb()
            ->andWhere('e.specialist = :specialist')
            ->andWhere('e.scheduledAt >= :from')
            ->andWhere('e.scheduledAt < :to')
            ->andWhere('e.status != :cancelled')
            ->andWhere('e.status != :proposed OR e.expiresAt > :now')
            ->andWhere('e.deletedAt IS NULL')
            ->setParameter('specialist', $specialistId)
            ->setParameter('from', $from)
            ->setParameter('to', $to)
            ->setParameter('cancelled', AppointmentStatus::CANCELLED->value)
            ->setParameter('proposed', AppointmentStatus::PROPOSED->value)
            ->setParameter('now', $now)
            ->getQuery();
    }

    // ----- Follow-ups -----
    // Each finder has a public *Query() twin so its DQL compiles in the offline tests.

    /** Every follow-up of a consultation (any status), soonest first. @return list<Appointment> */
    public function followUpsOf(string $parentId): array
    {
        return $this->followUpsQuery($parentId)->getResult();
    }

    public function followUpsQuery(string $parentId): Query
    {
        return $this->qb()
            ->andWhere('e.parent = :parent')
            ->andWhere('e.deletedAt IS NULL')
            ->setParameter('parent', $parentId)
            ->orderBy('e.scheduledAt', 'ASC')
            ->getQuery();
    }

    /** The consultation's follow-up proposal still awaiting the patient (at most one), if any. */
    public function openProposalFor(string $parentId, DateTimeImmutable $now): ?Appointment
    {
        return $this->openProposalQuery($parentId, $now)->getOneOrNullResult();
    }

    public function openProposalQuery(string $parentId, DateTimeImmutable $now): Query
    {
        return $this->qb()
            ->andWhere('e.parent = :parent')
            ->andWhere('e.status = :proposed')
            ->andWhere('e.expiresAt > :now')
            ->andWhere('e.deletedAt IS NULL')
            ->setParameter('parent', $parentId)
            ->setParameter('proposed', AppointmentStatus::PROPOSED->value)
            ->setParameter('now', $now)
            ->setMaxResults(1)
            ->getQuery();
    }

    /** Unanswered proposals past their expiry — the cron cancels these. @return list<Appointment> */
    public function expiredProposals(DateTimeImmutable $now, int $limit = 200): array
    {
        return $this->expiredProposalsQuery($now, $limit)->getResult();
    }

    public function expiredProposalsQuery(DateTimeImmutable $now, int $limit = 200): Query
    {
        return $this->qb()
            ->andWhere('e.status = :proposed')
            ->andWhere('e.expiresAt <= :now')
            ->andWhere('e.deletedAt IS NULL')
            ->setParameter('proposed', AppointmentStatus::PROPOSED->value)
            ->setParameter('now', $now)
            ->orderBy('e.expiresAt', 'ASC')
            ->setMaxResults($limit)
            ->getQuery();
    }

    /**
     * Open proposals closing within (now, until] whose patient hasn't been
     * reminded yet — the cron's nudge candidates.
     *
     * @return list<Appointment>
     */
    public function proposalsClosingBy(DateTimeImmutable $now, DateTimeImmutable $until, int $limit = 200): array
    {
        return $this->proposalsClosingByQuery($now, $until, $limit)->getResult();
    }

    public function proposalsClosingByQuery(DateTimeImmutable $now, DateTimeImmutable $until, int $limit = 200): Query
    {
        return $this->qb()
            ->andWhere('e.status = :proposed')
            ->andWhere('e.expiresAt > :now')
            ->andWhere('e.expiresAt <= :until')
            ->andWhere('e.followUpNudgedAt IS NULL')
            ->andWhere('e.deletedAt IS NULL')
            ->setParameter('proposed', AppointmentStatus::PROPOSED->value)
            ->setParameter('now', $now)
            ->setParameter('until', $until)
            ->orderBy('e.expiresAt', 'ASC')
            ->setMaxResults($limit)
            ->getQuery();
    }

    /**
     * The compare-and-set that answers a proposal: moves it out of PROPOSED
     * only while it still is (and, with `$openAt`, only while unexpired then),
     * so accept / decline / withdraw / expiry racing each other settle on
     * exactly one outcome.
     */
    public function proposalClaimQuery(string $appointmentId, AppointmentStatus $target, ?DateTimeImmutable $openAt = null): Query
    {
        $qb = $this->em->createQueryBuilder()
            ->update(Appointment::class, 'a')
            ->set('a.status', ':target')
            ->set('a.updatedAt', ':now')
            ->where('a.id = :id')
            ->andWhere('a.status = :proposed')
            ->setParameter('target', $target->value)
            ->setParameter('proposed', AppointmentStatus::PROPOSED->value)
            ->setParameter('now', new DateTimeImmutable())
            ->setParameter('id', $appointmentId);
        if ($openAt !== null) {
            $qb->andWhere('a.expiresAt > :openAt')->setParameter('openAt', $openAt);
        }

        return $qb->getQuery();
    }

    /** Run {@see proposalClaimQuery()}: true when THIS call moved the proposal. */
    public function claimProposal(string $appointmentId, AppointmentStatus $target, ?DateTimeImmutable $openAt = null): bool
    {
        return (int) $this->proposalClaimQuery($appointmentId, $target, $openAt)->execute() === 1;
    }

    /** Reload an appointment's stored state (after a compare-and-set bypassed the unit of work). */
    public function refresh(Appointment $appointment): void
    {
        $this->em->refresh($appointment);
    }

    /**
     * Run `$work` in one DB transaction (flushed and committed together, or
     * rolled back). An exception thrown inside closes the entity manager, so
     * `$work` should hand a validation problem back rather than throw it.
     *
     * @template T
     * @param callable(): T $work
     * @return T
     */
    public function transactional(callable $work): mixed
    {
        return $this->em->wrapInTransaction(static fn (): mixed => $work());
    }

    /** Hold a row lock on `$appointment` until the current transaction ends (call inside {@see transactional()}). */
    public function lockForUpdate(Appointment $appointment): void
    {
        $this->em->lock($appointment, LockMode::PESSIMISTIC_WRITE);
    }
}
