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

    /** `?sort_by=` values the appointment lists accept (see BaseRepository::safeSortField). */
    protected function sortableFields(): array
    {
        return ['scheduledAt', 'createdAt', 'updatedAt', 'status', 'id'];
    }

    /** `?when=` values the appointment lists accept ({@see applyWhen()}). */
    public const WHEN = ['upcoming', 'past', 'attention'];

    /** A `?when=` query value, normalised: upcoming | past | attention, or null (anything else). */
    public static function parseWhen(mixed $raw, array $allowed = self::WHEN): ?string
    {
        $when = is_string($raw) ? strtolower(trim($raw)) : '';

        return in_array($when, $allowed, true) ? $when : null;
    }

    /**
     * @param list<AppointmentStatus>|null $statuses
     * @param string|null                  $when    upcoming | past | attention ({@see applyWhen()}) —
     *                                              then sorted by start: upcoming soonest first, else newest first
     * @param list<string>                 $liveIds appointments someone is in the call of right now
     * @return array{items: list<Appointment>, total: int}
     */
    public function paginated(
        int $offset,
        int $perPage,
        string $sortBy = 'createdAt',
        string $sortDir = 'desc',
        ?string $patientId = null,
        ?array $statuses = null,
        ?string $when = null,
        ?DateTimeImmutable $now = null,
        array $liveIds = [],
    ): array {
        $qb = $this->paginatedBuilder($patientId, $statuses, $when, $now ?? new DateTimeImmutable(), $liveIds);
        if ($when !== null) {
            [$sortBy, $sortDir] = ['scheduledAt', $when === 'upcoming' ? 'asc' : 'desc'];
        }

        return $this->paginatedQuery($qb, $this->alias(), $offset, $perPage, $sortBy, $sortDir);
    }

    /**
     * {@see paginated()}'s filters as a builder (public so its DQL compiles in
     * the offline tests).
     *
     * @param list<AppointmentStatus>|null $statuses
     * @param list<string>                 $liveIds
     */
    public function paginatedBuilder(
        ?string $patientId,
        ?array $statuses,
        ?string $when,
        DateTimeImmutable $now,
        array $liveIds = [],
    ): \Doctrine\ORM\QueryBuilder {
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
        if ($when !== null) {
            $this->applyWhen($qb, 'e', $when, $now, $liveIds);
        }

        return $qb;
    }

    /**
     * Split a list by TIME ({@see \App\Domain\Appointment\AppointmentLifecycle::phase()}):
     *  - upcoming:  not closed (completed / cancelled / missed) and still to
     *               come or live — its slot ends after now − LIVE_GRACE_MINUTES,
     *               or someone is in its call (`$liveIds`); a proposal only
     *               while unexpired;
     *  - past:      everything else — closed, or ended over the grace ago;
     *  - attention: past bookings still open (pending / confirmed /
     *               rescheduled) — what the cron closes or the back office resolves.
     * Joins the specialist (as `w_s`) for the slot length.
     *
     * @param list<string> $liveIds
     */
    public function applyWhen(\Doctrine\ORM\QueryBuilder $qb, string $alias, string $when, DateTimeImmutable $now, array $liveIds = []): void
    {
        $qb->join("$alias.specialist", 'w_s');
        $ended   = "DATE_ADD($alias.scheduledAt, w_s.slotMinutes, 'minute') <= :w_grace";
        $expired = "($alias.status = :w_proposed AND $alias.expiresAt <= :w_now)";
        $closed  = "$alias.status IN (:w_closed)";
        $live    = $liveIds !== [] ? " AND $alias.id NOT IN (:w_live)" : '';

        $grace = $now->modify('-' . \App\Domain\Appointment\AppointmentLifecycle::LIVE_GRACE_MINUTES . ' minutes');
        if ($when === 'attention') {
            $qb->andWhere("$alias.status IN (:w_open)")
                ->andWhere($ended . $live)
                ->setParameter('w_open', array_map(static fn (AppointmentStatus $s): string => $s->value, AppointmentStatus::openBookings()))
                ->setParameter('w_grace', $grace);
        } else {
            // past = closed OR ((ended OR an expired proposal) AND nobody in the call)
            $past = "$closed OR (($ended OR $expired)$live)";
            $qb->andWhere($when === 'upcoming' ? "NOT ($past)" : $past)
                ->setParameter('w_closed', array_map(static fn (AppointmentStatus $s): string => $s->value, AppointmentStatus::terminal()))
                ->setParameter('w_proposed', AppointmentStatus::PROPOSED->value)
                ->setParameter('w_now', $now)
                ->setParameter('w_grace', $grace);
        }
        if ($liveIds !== []) {
            $qb->setParameter('w_live', array_values($liveIds));
        }
    }

    /**
     * True if a card payment reference has already been used — to book, or to
     * pay for a guest invited later (kept on that guest's entry).
     */
    public function existsByPaymentReference(string $reference): bool
    {
        $booked = (int) $this->em->createQueryBuilder()
            ->select('COUNT(e.id)')
            ->from(Appointment::class, 'e')
            ->andWhere('e.paymentReference = :ref')
            ->setParameter('ref', $reference)
            ->getQuery()
            ->getSingleScalarResult() > 0;

        return $booked || $this->guestPaymentExists($reference);
    }

    /** True if a guest entry of any appointment holds this card payment reference. */
    public function guestPaymentExists(string $reference): bool
    {
        return (int) $this->em->getConnection()->fetchOne(
            self::GUEST_PAYMENT_SQL,
            ['needle' => json_encode([['payment_reference' => $reference]], JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR)],
        ) > 0;
    }

    /** Guest entries live in the appointments.guests JSON list (a json column; jsonb for containment). */
    public const GUEST_PAYMENT_SQL = 'SELECT COUNT(*) FROM appointments WHERE guests IS NOT NULL AND CAST(guests AS jsonb) @> CAST(:needle AS jsonb)';

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
     * `refunded_amount` is what went back to the wallet for a still-`paid` row
     * (a partial refund: a missed consultation, a late cancellation).
     *
     * @return list<array{created_at: DateTimeImmutable, amount: string, refunded_amount: string, payment_status: string, status: string, type: string, specialist_id: string, specialist_name: string}>
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
                'refunded_amount' => bcadd((string) ($r['refunded_amount'] ?? '0'), '0', 2),
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
                'e.refundedAmount AS refunded_amount',
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
     * long history (one consultation is loaded by id instead). With `$when`
     * (upcoming | past | attention) the list is split by time instead
     * ({@see scheduleWhenQuery()}).
     *
     * @param list<string> $liveIds appointments someone is in the call of right now (for `$when`)
     * @return list<Appointment>
     */
    public function forSpecialist(string $specialistId, int $limit = 100, ?DateTimeImmutable $now = null, ?string $when = null, array $liveIds = []): array
    {
        if ($when !== null) {
            /** @var list<Appointment> */
            return $this->scheduleWhenQuery($specialistId, $when, $now ?? new DateTimeImmutable(), $limit, $liveIds)->getResult();
        }
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
     * The doctor's schedule split by time ({@see applyWhen()}): upcoming
     * (incl. live) soonest first, past / attention newest first, `$limit` rows.
     *
     * @param list<string> $liveIds
     */
    public function scheduleWhenQuery(string $specialistId, string $when, DateTimeImmutable $now, int $limit = 100, array $liveIds = []): Query
    {
        $qb = $this->qb()
            ->andWhere('e.specialist = :specialist')
            ->andWhere('e.deletedAt IS NULL')
            ->setParameter('specialist', $specialistId);
        $this->applyWhen($qb, 'e', $when, $now, $liveIds);

        return $qb->orderBy('e.scheduledAt', $when === 'upcoming' ? 'ASC' : 'DESC')
            ->addOrderBy('e.id', 'ASC')
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
                AppointmentStatus::MISSED->value,
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
            ->setParameter('notHeld', [AppointmentStatus::CANCELLED->value, AppointmentStatus::PROPOSED->value, AppointmentStatus::MISSED->value])
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
            ->setParameter('done', [AppointmentStatus::CANCELLED->value, AppointmentStatus::COMPLETED->value, AppointmentStatus::MISSED->value, AppointmentStatus::PROPOSED->value])
            ->orderBy('e.scheduledAt', 'ASC')
            ->setMaxResults(1)
            ->getQuery()
            ->getOneOrNullResult();
    }

    /**
     * Paginated appointment history for a specialist, newest first, optionally
     * filtered by status, a patient-name search and the time split
     * (`$when` upcoming | past | attention — {@see applyWhen()}; upcoming is
     * soonest first).
     *
     * @param list<AppointmentStatus>|null $statuses
     * @param list<string>                 $liveIds
     * @return array{items: list<Appointment>, total: int}
     */
    public function paginatedForSpecialist(
        int $offset,
        int $perPage,
        string $specialistId,
        ?array $statuses = null,
        ?string $search = null,
        ?string $when = null,
        ?DateTimeImmutable $now = null,
        array $liveIds = [],
    ): array {
        $qb = $this->specialistListBuilder($specialistId, $statuses, $search, $when, $now ?? new DateTimeImmutable(), $liveIds);

        return $this->paginatedQuery($qb, $this->alias(), $offset, $perPage, 'scheduledAt', $when === 'upcoming' ? 'asc' : 'desc');
    }

    /**
     * {@see paginatedForSpecialist()}'s filters as a builder (public so its
     * DQL compiles in the offline tests).
     *
     * @param list<AppointmentStatus>|null $statuses
     * @param list<string>                 $liveIds
     */
    public function specialistListBuilder(
        string $specialistId,
        ?array $statuses,
        ?string $search,
        ?string $when,
        DateTimeImmutable $now,
        array $liveIds = [],
    ): \Doctrine\ORM\QueryBuilder {
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
        if ($when !== null) {
            $this->applyWhen($qb, 'e', $when, $now, $liveIds);
        }

        return $qb;
    }

    /**
     * Requests the doctor can still confirm: pending or rescheduled, and not
     * yet CONFIRM_GRACE_MINUTES past their end (the dashboard's pending count).
     */
    public function countOpenRequestsForSpecialist(string $specialistId, DateTimeImmutable $now): int
    {
        return (int) $this->openRequestsCountQuery($specialistId, $now)->getSingleScalarResult();
    }

    public function openRequestsCountQuery(string $specialistId, DateTimeImmutable $now): Query
    {
        return $this->em->createQueryBuilder()
            ->select('COUNT(e.id)')
            ->from(Appointment::class, 'e')
            ->join('e.specialist', 'r_s')
            ->andWhere('e.specialist = :specialist')
            ->andWhere('e.deletedAt IS NULL')
            ->andWhere('e.status IN (:requests)')
            ->andWhere("DATE_ADD(e.scheduledAt, r_s.slotMinutes, 'minute') > :cutoff")
            ->setParameter('specialist', $specialistId)
            ->setParameter('requests', [AppointmentStatus::PENDING->value, AppointmentStatus::RESCHEDULED->value])
            ->setParameter('cutoff', $now->modify('-' . \App\Domain\Appointment\AppointmentLifecycle::CONFIRM_GRACE_MINUTES . ' minutes'))
            ->getQuery();
    }

    /**
     * What the doctor earned (gross, before commission) from consultations in
     * an optional [from, to) start window: every completed one, and a missed
     * one the patient didn't come to (the fee is the doctor's) — each less
     * what was refunded for it (money string, scale 2).
     */
    public function sumEarnedForSpecialist(string $specialistId, ?DateTimeImmutable $from = null, ?DateTimeImmutable $to = null): string
    {
        $value = $this->earnedSumQuery($specialistId, $from, $to)->getSingleScalarResult();

        return number_format((float) $value, 2, '.', '');
    }

    public function earnedSumQuery(string $specialistId, ?DateTimeImmutable $from = null, ?DateTimeImmutable $to = null): Query
    {
        $qb = $this->em->createQueryBuilder()
            ->select('COALESCE(SUM(e.amount - COALESCE(e.refundedAmount, 0)), 0)')
            ->from(Appointment::class, 'e')
            ->andWhere('e.specialist = :specialist')
            ->andWhere('e.deletedAt IS NULL')
            ->setParameter('specialist', $specialistId);
        $this->applyEarned($qb, 'e');
        $this->applyStatusWindow($qb, null, $from, $to);

        return $qb->getQuery();
    }

    /**
     * The consultations that earned the doctor something, newest first — the
     * earnings transactions list ({@see sumEarnedForSpecialist()}'s rows).
     *
     * @return array{items: list<Appointment>, total: int}
     */
    public function paginatedEarnedForSpecialist(int $offset, int $perPage, string $specialistId): array
    {
        $qb = $this->qb()
            ->andWhere('e.specialist = :specialist')
            ->andWhere('e.deletedAt IS NULL')
            ->setParameter('specialist', $specialistId);
        $this->applyEarned($qb, 'e');

        return $this->paginatedQuery($qb, $this->alias(), $offset, $perPage, 'scheduledAt', 'desc');
    }

    /** completed, or missed with the patient the one who didn't come. */
    private function applyEarned(\Doctrine\ORM\QueryBuilder $qb, string $alias): void
    {
        $qb->andWhere("$alias.status = :earn_completed OR ($alias.status = :earn_missed AND $alias.noShow = :earn_patient)")
            ->setParameter('earn_completed', AppointmentStatus::COMPLETED->value)
            ->setParameter('earn_missed', AppointmentStatus::MISSED->value)
            ->setParameter('earn_patient', 'patient');
    }

    /**
     * A doctor's no-shows (missed, `no_show` doctor) whose start falls in
     * [from, to) — for the back office's repeated no-show alert.
     */
    public function countDoctorNoShows(string $specialistId, DateTimeImmutable $from, DateTimeImmutable $to): int
    {
        return (int) $this->doctorNoShowsQuery($specialistId, $from, $to)->getSingleScalarResult();
    }

    public function doctorNoShowsQuery(string $specialistId, DateTimeImmutable $from, DateTimeImmutable $to): Query
    {
        return $this->em->createQueryBuilder()
            ->select('COUNT(e.id)')
            ->from(Appointment::class, 'e')
            ->andWhere('e.specialist = :specialist')
            ->andWhere('e.deletedAt IS NULL')
            ->andWhere('e.status = :missed')
            ->andWhere('e.noShow = :doctor')
            ->andWhere('e.scheduledAt >= :from')
            ->andWhere('e.scheduledAt < :to')
            ->setParameter('specialist', $specialistId)
            ->setParameter('missed', AppointmentStatus::MISSED->value)
            ->setParameter('doctor', 'doctor')
            ->setParameter('from', $from)
            ->setParameter('to', $to)
            ->getQuery();
    }

    /** A specialist's missed consultations the patient didn't come to (they earn the doctor the fee). */
    public function countPatientNoShowsForSpecialist(string $specialistId): int
    {
        return (int) $this->em->createQueryBuilder()
            ->select('COUNT(e.id)')
            ->from(Appointment::class, 'e')
            ->andWhere('e.specialist = :specialist')
            ->andWhere('e.deletedAt IS NULL')
            ->andWhere('e.status = :missed')
            ->andWhere('e.noShow = :patient')
            ->setParameter('specialist', $specialistId)
            ->setParameter('missed', AppointmentStatus::MISSED->value)
            ->setParameter('patient', 'patient')
            ->getQuery()
            ->getSingleScalarResult();
    }

    /**
     * A call heartbeat from `$role` (patient | doctor): store their first one
     * inside the presence window ({@see \App\Domain\Appointment\AppointmentLifecycle::presenceWindow()})
     * of an open booking, once — durable evidence of who came, for the closer.
     * Cheap: nothing is written once the stamp is set (or outside the window).
     */
    public function recordPresence(Appointment $appointment, string $role, DateTimeImmutable $now): bool
    {
        if (
            !in_array($role, ['patient', 'doctor'], true)
            || $appointment->getFirstJoinedAt($role) !== null
            || !$appointment->getStatus()->isOpenBooking()
            || !\App\Domain\Appointment\AppointmentLifecycle::inPresenceWindow($appointment, $now)
        ) {
            return false;
        }
        try {
            return $this->stampFirstJoin($appointment, $role, $now);
        } catch (\Throwable $e) {
            error_log('[presence] first-join stamp failed: ' . $e->getMessage());

            return false; // best effort: a heartbeat never fails over it
        }
    }

    /**
     * Store `$role`'s (patient | doctor) first call heartbeat — once: a
     * compare-and-set on the still-empty column, so concurrent heartbeats
     * write it once and later ones never move it. True when this call stored it.
     */
    public function stampFirstJoin(Appointment $appointment, string $role, DateTimeImmutable $at): bool
    {
        $query = $this->firstJoinStampQuery($appointment->getId(), $role, $at);
        if ($query === null) {
            return false;
        }
        $stored = (int) $query->execute() === 1;
        $appointment->markFirstJoined($role, $at);

        return $stored;
    }

    public function firstJoinStampQuery(string $appointmentId, string $role, DateTimeImmutable $at): ?Query
    {
        $field = match ($role) {
            'doctor'  => 'doctorFirstJoinedAt',
            'patient' => 'patientFirstJoinedAt',
            default   => null,
        };
        if ($field === null) {
            return null;
        }

        return $this->em->createQueryBuilder()
            ->update(Appointment::class, 'a')
            ->set("a.$field", ':at')
            ->where('a.id = :id')
            ->andWhere("a.$field IS NULL")
            ->setParameter('at', $at)
            ->setParameter('id', $appointmentId)
            ->getQuery();
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

    /**
     * The batched twin of {@see forSpecialistBetween()} for availability: the
     * start times of several specialists' live appointments in [from, to) as
     * plain rows (specialist_id, scheduled_at) — same rules (not cancelled, not
     * deleted, an open proposal holds its time until it expires), no entities.
     * `$ignoreId`: an appointment being moved — its own time isn't in its way.
     *
     * @param list<string> $specialistIds
     * @return list<array{specialist_id:string, scheduled_at:mixed}>
     */
    public function takenStartsFor(
        array $specialistIds,
        DateTimeImmutable $from,
        DateTimeImmutable $to,
        DateTimeImmutable $now,
        ?string $ignoreId = null,
    ): array {
        if ($specialistIds === []) {
            return [];
        }

        return $this->takenStartsForQuery($specialistIds, $from, $to, $now, $ignoreId)->getArrayResult();
    }

    /** @param list<string> $specialistIds */
    public function takenStartsForQuery(
        array $specialistIds,
        DateTimeImmutable $from,
        DateTimeImmutable $to,
        DateTimeImmutable $now,
        ?string $ignoreId = null,
    ): Query {
        $qb = $this->em->createQueryBuilder()
            ->select('IDENTITY(e.specialist) AS specialist_id', 'e.scheduledAt AS scheduled_at')
            ->from(Appointment::class, 'e')
            ->andWhere('e.specialist IN (:ids)')
            ->andWhere('e.scheduledAt >= :from')
            ->andWhere('e.scheduledAt < :to')
            ->andWhere('e.status != :cancelled')
            ->andWhere('e.status != :proposed OR e.expiresAt > :now')
            ->andWhere('e.deletedAt IS NULL')
            ->setParameter('ids', $specialistIds)
            ->setParameter('from', $from)
            ->setParameter('to', $to)
            ->setParameter('cancelled', AppointmentStatus::CANCELLED->value)
            ->setParameter('proposed', AppointmentStatus::PROPOSED->value)
            ->setParameter('now', $now);
        if ($ignoreId !== null && $ignoreId !== '') {
            $qb->andWhere('e.id != :ignore')->setParameter('ignore', $ignoreId);
        }

        return $qb->getQuery();
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

    /**
     * Lock `$appointment`'s row and reload it, so a read-modify-write of its
     * JSON (the guest list) sees what another request just saved and can't
     * lose it (call inside {@see transactional()}, before changing it).
     */
    public function lockAndRefresh(Appointment $appointment): void
    {
        $this->em->refresh($appointment, LockMode::PESSIMISTIC_WRITE);
    }

    /**
     * Record something about one guest ({@see Appointment::updateGuest()}) under
     * the row lock, so it can't undo a guest-list change saved a moment ago.
     * Returns the updated entry, or null when that guest is no longer invited.
     *
     * @param array<string,mixed> $changes
     * @return array<string,mixed>|null
     */
    public function updateGuestLocked(Appointment $appointment, string $guestId, array $changes): ?array
    {
        return $this->transactional(function () use ($appointment, $guestId, $changes): ?array {
            $this->lockAndRefresh($appointment);
            $updated = $appointment->updateGuest($guestId, $changes);
            if ($updated !== null) {
                $this->save($appointment);
            }

            return $updated;
        });
    }
}
