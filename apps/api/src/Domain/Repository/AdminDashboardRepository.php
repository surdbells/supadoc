<?php

declare(strict_types=1);

namespace App\Domain\Repository;

use App\Domain\Entity\Appointment;
use App\Domain\Entity\AuditEvent;
use App\Domain\Entity\Patient;
use App\Domain\Entity\PaymentIntent;
use App\Domain\Entity\Payout;
use App\Domain\Entity\ReferenceItem;
use App\Domain\Entity\Review;
use App\Domain\Entity\Specialist;
use App\Domain\Entity\WalletTransaction;
use App\Domain\Enum\AppointmentStatus;
use App\Domain\Enum\SpecialistStatus;
use DateTimeImmutable;
use DateTimeZone;
use Doctrine\ORM\EntityManagerInterface;
use Doctrine\ORM\Query;
use Doctrine\ORM\QueryBuilder;

/**
 * The aggregate reads behind the back-office dashboard (GET /api/admin/dashboard),
 * across several tables. Every figure is one DQL aggregate — conditional SUMs
 * over an indexed-or-small range — so a dashboard load is a dozen cheap
 * queries, never a row-by-row scan in PHP. Each query has a public `…Query()`
 * so the offline tests compile it to SQL.
 *
 * Windows are half-open [from, to). Instants may come in any zone: they are
 * converted to the process zone, which is what the naive timestamp columns
 * hold, before they are bound.
 *
 * A booking here is what the analytics count as one: never a follow-up
 * proposal the patient didn't accept (still open, or declined / withdrawn /
 * expired — cancelled and never paid).
 */
final class AdminDashboardRepository
{
    /** Audit actions too routine for the dashboard's activity feed (reads, initiations, throttles). */
    public const QUIET_AUDIT_ACTIONS = [
        'prescription.viewed',
        'prescription.opened',
        'prescription.downloaded',
        'prescription.checked',
        'specialist.credential_viewed',
        'signature.used',
        'wallet.topup_initiated',
        // Document sharing: every file view and list view, and the system's
        // routine expiries, would otherwise flood "Recent activity".
        'document.viewed',
        'document.list_viewed',
        'document_access.expired',
        'document_access.request_expired',
    ];

    /** How many stored specialty spellings topSpecialties() reads before merging them. */
    private const SPELLINGS_SCANNED = 200;

    public function __construct(private readonly EntityManagerInterface $em)
    {
    }

    // ----- KPIs (current vs previous window) -----

    /**
     * Bookings made, paid bookings and revenue (paid bookings — follow-ups and
     * guest fees included, they are part of `amount` — less what was refunded
     * for them) by booking date, for both windows.
     *
     * @return array{bookings_cur:int, bookings_prev:int, paid_cur:int, paid_prev:int, revenue_cur:string, revenue_prev:string}
     */
    public function bookingTotals(DateTimeImmutable $from, DateTimeImmutable $to, DateTimeImmutable $prevFrom, DateTimeImmutable $prevTo): array
    {
        $r = $this->bookingTotalsQuery($from, $to, $prevFrom, $prevTo)->getSingleResult();

        return [
            'bookings_cur' => (int) ($r['bookings_cur'] ?? 0),
            'bookings_prev' => (int) ($r['bookings_prev'] ?? 0),
            'paid_cur'     => (int) ($r['paid_cur'] ?? 0),
            'paid_prev'    => (int) ($r['paid_prev'] ?? 0),
            'revenue_cur'  => self::money($r['revenue_cur'] ?? null),
            'revenue_prev' => self::money($r['revenue_prev'] ?? null),
        ];
    }

    public function bookingTotalsQuery(DateTimeImmutable $from, DateTimeImmutable $to, DateTimeImmutable $prevFrom, DateTimeImmutable $prevTo): Query
    {
        $cur  = 'e.createdAt >= :cf AND e.createdAt < :ct';
        $prev = 'e.createdAt >= :pf AND e.createdAt < :pt';
        $net  = 'e.amount - COALESCE(e.refundedAmount, 0)';

        $qb = $this->em->createQueryBuilder()
            ->select(
                "SUM(CASE WHEN $cur THEN 1 ELSE 0 END) AS bookings_cur",
                "SUM(CASE WHEN $prev THEN 1 ELSE 0 END) AS bookings_prev",
                "SUM(CASE WHEN $cur AND e.paymentStatus = :paid THEN 1 ELSE 0 END) AS paid_cur",
                "SUM(CASE WHEN $prev AND e.paymentStatus = :paid THEN 1 ELSE 0 END) AS paid_prev",
                "SUM(CASE WHEN $cur AND e.paymentStatus = :paid THEN $net ELSE 0 END) AS revenue_cur",
                "SUM(CASE WHEN $prev AND e.paymentStatus = :paid THEN $net ELSE 0 END) AS revenue_prev",
            )
            ->from(Appointment::class, 'e')
            ->andWhere('e.deletedAt IS NULL')
            ->andWhere("($cur) OR ($prev)")
            ->setParameter('paid', 'paid');
        $this->onlyBookings($qb, 'e');
        $this->bindWindows($qb, $from, $to, $prevFrom, $prevTo);

        return $qb->getQuery();
    }

    /**
     * Consultations completed, cancelled and missed by when they closed
     * (closed_at; rows from before it was kept fall back to updated_at), for
     * both windows, and the current window's missed ones by who didn't come.
     *
     * @return array{completed_cur:int, completed_prev:int, cancelled_cur:int, cancelled_prev:int, missed_cur:int, missed_prev:int, missed_patient:int, missed_doctor:int, missed_both:int}
     */
    public function closedTotals(DateTimeImmutable $from, DateTimeImmutable $to, DateTimeImmutable $prevFrom, DateTimeImmutable $prevTo): array
    {
        $r = $this->closedTotalsQuery($from, $to, $prevFrom, $prevTo)->getSingleResult();
        $keys = ['completed_cur', 'completed_prev', 'cancelled_cur', 'cancelled_prev', 'missed_cur', 'missed_prev', 'missed_patient', 'missed_doctor', 'missed_both'];

        return array_combine($keys, array_map(static fn (string $k): int => (int) ($r[$k] ?? 0), $keys));
    }

    public function closedTotalsQuery(DateTimeImmutable $from, DateTimeImmutable $to, DateTimeImmutable $prevFrom, DateTimeImmutable $prevTo): Query
    {
        $at   = 'COALESCE(e.closedAt, e.updatedAt)';
        $cur  = "$at >= :cf AND $at < :ct";
        $prev = "$at >= :pf AND $at < :pt";

        $qb = $this->em->createQueryBuilder()
            ->select(
                "SUM(CASE WHEN e.status = :completed AND $cur THEN 1 ELSE 0 END) AS completed_cur",
                "SUM(CASE WHEN e.status = :completed AND $prev THEN 1 ELSE 0 END) AS completed_prev",
                "SUM(CASE WHEN e.status = :cancelled AND $cur THEN 1 ELSE 0 END) AS cancelled_cur",
                "SUM(CASE WHEN e.status = :cancelled AND $prev THEN 1 ELSE 0 END) AS cancelled_prev",
                "SUM(CASE WHEN e.status = :missed AND $cur THEN 1 ELSE 0 END) AS missed_cur",
                "SUM(CASE WHEN e.status = :missed AND $prev THEN 1 ELSE 0 END) AS missed_prev",
                "SUM(CASE WHEN e.status = :missed AND $cur AND e.noShow = :ns_patient THEN 1 ELSE 0 END) AS missed_patient",
                "SUM(CASE WHEN e.status = :missed AND $cur AND e.noShow = :ns_doctor THEN 1 ELSE 0 END) AS missed_doctor",
                "SUM(CASE WHEN e.status = :missed AND $cur AND e.noShow = :ns_both THEN 1 ELSE 0 END) AS missed_both",
            )
            ->from(Appointment::class, 'e')
            ->andWhere('e.deletedAt IS NULL')
            ->andWhere('e.status IN (:closed_statuses)')
            ->andWhere("($cur) OR ($prev)")
            ->setParameter('completed', AppointmentStatus::COMPLETED->value)
            ->setParameter('missed', AppointmentStatus::MISSED->value)
            ->setParameter('closed_statuses', array_map(static fn (AppointmentStatus $s): string => $s->value, AppointmentStatus::terminal()))
            ->setParameter('ns_patient', 'patient')
            ->setParameter('ns_doctor', 'doctor')
            ->setParameter('ns_both', 'both');
        // binds :cancelled as well — the proposal filter below uses it too
        $this->onlyBookings($qb, 'e');
        $this->bindWindows($qb, $from, $to, $prevFrom, $prevTo);

        return $qb->getQuery();
    }

    /** @return array{cur:int, prev:int} new patient accounts in each window */
    public function newPatients(DateTimeImmutable $from, DateTimeImmutable $to, DateTimeImmutable $prevFrom, DateTimeImmutable $prevTo): array
    {
        $r = $this->newPatientsQuery($from, $to, $prevFrom, $prevTo)->getSingleResult();

        return ['cur' => (int) ($r['cur'] ?? 0), 'prev' => (int) ($r['prev'] ?? 0)];
    }

    public function newPatientsQuery(DateTimeImmutable $from, DateTimeImmutable $to, DateTimeImmutable $prevFrom, DateTimeImmutable $prevTo): Query
    {
        $cur  = 'e.createdAt >= :cf AND e.createdAt < :ct';
        $prev = 'e.createdAt >= :pf AND e.createdAt < :pt';
        $qb   = $this->em->createQueryBuilder()
            ->select("SUM(CASE WHEN $cur THEN 1 ELSE 0 END) AS cur", "SUM(CASE WHEN $prev THEN 1 ELSE 0 END) AS prev")
            ->from(Patient::class, 'e')
            ->andWhere('e.deletedAt IS NULL')
            ->andWhere("($cur) OR ($prev)");
        $this->bindWindows($qb, $from, $to, $prevFrom, $prevTo);

        return $qb->getQuery();
    }

    /**
     * Doctors now: approved (or legacy, no status), and of those the ones
     * switched on for bookings — "active doctors". A snapshot, no history.
     *
     * @return array{approved:int, taking_bookings:int}
     */
    public function activeDoctors(): array
    {
        $r = $this->activeDoctorsQuery()->getSingleResult();

        return ['approved' => (int) ($r['approved'] ?? 0), 'taking_bookings' => (int) ($r['taking_bookings'] ?? 0)];
    }

    public function activeDoctorsQuery(): Query
    {
        return $this->em->createQueryBuilder()
            ->select('COUNT(e.id) AS approved', 'SUM(CASE WHEN e.available = true THEN 1 ELSE 0 END) AS taking_bookings')
            ->from(Specialist::class, 'e')
            ->andWhere('e.deletedAt IS NULL')
            ->andWhere('e.status IS NULL OR e.status = :approved')
            ->setParameter('approved', SpecialistStatus::APPROVED->value)
            ->getQuery();
    }

    /**
     * Wallet top-ups credited and refunds paid back to wallets (successful
     * ledger entries in `$currency`, by when they posted), both windows.
     *
     * @return array{topup_count_cur:int, topup_count_prev:int, topup_sum_cur:string, topup_sum_prev:string, refund_count_cur:int, refund_count_prev:int, refund_sum_cur:string, refund_sum_prev:string}
     */
    public function walletTotals(DateTimeImmutable $from, DateTimeImmutable $to, DateTimeImmutable $prevFrom, DateTimeImmutable $prevTo, string $currency): array
    {
        $r = $this->walletTotalsQuery($from, $to, $prevFrom, $prevTo, $currency)->getSingleResult();
        $out = [];
        foreach (['topup', 'refund'] as $type) {
            foreach (['cur', 'prev'] as $w) {
                $out["{$type}_count_$w"] = (int) ($r["{$type}_count_$w"] ?? 0);
                $out["{$type}_sum_$w"]   = self::money($r["{$type}_sum_$w"] ?? null);
            }
        }

        /** @var array{topup_count_cur:int, topup_count_prev:int, topup_sum_cur:string, topup_sum_prev:string, refund_count_cur:int, refund_count_prev:int, refund_sum_cur:string, refund_sum_prev:string} $out */
        return $out;
    }

    public function walletTotalsQuery(DateTimeImmutable $from, DateTimeImmutable $to, DateTimeImmutable $prevFrom, DateTimeImmutable $prevTo, string $currency): Query
    {
        $at     = 'COALESCE(e.postedAt, e.createdAt)';
        $cur    = "$at >= :cf AND $at < :ct";
        $prev   = "$at >= :pf AND $at < :pt";
        $select = [];
        foreach (['topup' => ':t_topup', 'refund' => ':t_refund'] as $type => $param) {
            foreach (['cur' => $cur, 'prev' => $prev] as $w => $window) {
                $select[] = "SUM(CASE WHEN e.type = $param AND $window THEN 1 ELSE 0 END) AS {$type}_count_$w";
                $select[] = "SUM(CASE WHEN e.type = $param AND $window THEN e.amount ELSE 0 END) AS {$type}_sum_$w";
            }
        }

        $qb = $this->em->createQueryBuilder()
            ->select(...$select)
            ->from(WalletTransaction::class, 'e')
            ->andWhere('e.status = :success')
            ->andWhere('e.type IN (:types)')
            ->andWhere('e.currency = :currency')
            ->andWhere("($cur) OR ($prev)")
            ->setParameter('success', WalletTransaction::STATUS_SUCCESS)
            ->setParameter('types', [WalletTransaction::TYPE_TOPUP, WalletTransaction::TYPE_REFUND])
            ->setParameter('t_topup', WalletTransaction::TYPE_TOPUP)
            ->setParameter('t_refund', WalletTransaction::TYPE_REFUND)
            ->setParameter('currency', strtoupper($currency));
        $this->bindWindows($qb, $from, $to, $prevFrom, $prevTo);

        return $qb->getQuery();
    }

    /**
     * Patients' reviews left in each window: count and rating total (the
     * average is total / count — null when there are none).
     *
     * @return array{count_cur:int, sum_cur:int, count_prev:int, sum_prev:int}
     */
    public function ratings(DateTimeImmutable $from, DateTimeImmutable $to, DateTimeImmutable $prevFrom, DateTimeImmutable $prevTo): array
    {
        $r = $this->ratingsQuery($from, $to, $prevFrom, $prevTo)->getSingleResult();

        return [
            'count_cur'  => (int) ($r['count_cur'] ?? 0),
            'sum_cur'    => (int) ($r['sum_cur'] ?? 0),
            'count_prev' => (int) ($r['count_prev'] ?? 0),
            'sum_prev'   => (int) ($r['sum_prev'] ?? 0),
        ];
    }

    public function ratingsQuery(DateTimeImmutable $from, DateTimeImmutable $to, DateTimeImmutable $prevFrom, DateTimeImmutable $prevTo): Query
    {
        $cur  = 'e.createdAt >= :cf AND e.createdAt < :ct';
        $prev = 'e.createdAt >= :pf AND e.createdAt < :pt';
        $qb   = $this->em->createQueryBuilder()
            ->select(
                "SUM(CASE WHEN $cur THEN 1 ELSE 0 END) AS count_cur",
                "SUM(CASE WHEN $cur THEN e.rating ELSE 0 END) AS sum_cur",
                "SUM(CASE WHEN $prev THEN 1 ELSE 0 END) AS count_prev",
                "SUM(CASE WHEN $prev THEN e.rating ELSE 0 END) AS sum_prev",
            )
            ->from(Review::class, 'e')
            ->andWhere("($cur) OR ($prev)");
        $this->bindWindows($qb, $from, $to, $prevFrom, $prevTo);

        return $qb->getQuery();
    }

    // ----- Trends (one bucket per local day) -----

    /**
     * Bookings made and revenue per day bucket ([bounds[i], bounds[i + 1])).
     *
     * @param list<DateTimeImmutable> $bounds ascending day boundaries (n + 1 for n buckets)
     * @return list<array{bookings:int, revenue:string}>
     */
    public function dailyBookings(array $bounds): array
    {
        $n = count($bounds) - 1;
        if ($n < 1) {
            return [];
        }
        $r   = $this->dailyBookingsQuery($bounds)->getSingleResult();
        $out = [];
        for ($i = 0; $i < $n; $i++) {
            $out[] = ['bookings' => (int) ($r["b$i"] ?? 0), 'revenue' => self::money($r["r$i"] ?? null)];
        }

        return $out;
    }

    /** @param list<DateTimeImmutable> $bounds */
    public function dailyBookingsQuery(array $bounds): Query
    {
        $n      = count($bounds) - 1;
        $net    = 'e.amount - COALESCE(e.refundedAmount, 0)';
        $select = [];
        for ($i = 0; $i < $n; $i++) {
            $in       = 'e.createdAt >= :d' . $i . ' AND e.createdAt < :d' . ($i + 1);
            $select[] = "SUM(CASE WHEN $in THEN 1 ELSE 0 END) AS b$i";
            $select[] = "SUM(CASE WHEN $in AND e.paymentStatus = :paid THEN $net ELSE 0 END) AS r$i";
        }

        $qb = $this->em->createQueryBuilder()
            ->select(...$select)
            ->from(Appointment::class, 'e')
            ->andWhere('e.deletedAt IS NULL')
            ->andWhere('e.createdAt >= :d0')
            ->andWhere('e.createdAt < :d' . $n)
            ->setParameter('paid', 'paid');
        $this->onlyBookings($qb, 'e');
        $this->bindBounds($qb, $bounds);

        return $qb->getQuery();
    }

    /**
     * Consultations completed per day bucket (by when they closed).
     *
     * @param list<DateTimeImmutable> $bounds
     * @return list<int>
     */
    public function dailyCompleted(array $bounds): array
    {
        $n = count($bounds) - 1;
        if ($n < 1) {
            return [];
        }
        $r   = $this->dailyCompletedQuery($bounds)->getSingleResult();
        $out = [];
        for ($i = 0; $i < $n; $i++) {
            $out[] = (int) ($r["c$i"] ?? 0);
        }

        return $out;
    }

    /** @param list<DateTimeImmutable> $bounds */
    public function dailyCompletedQuery(array $bounds): Query
    {
        $n      = count($bounds) - 1;
        $at     = 'COALESCE(e.closedAt, e.updatedAt)';
        $select = [];
        for ($i = 0; $i < $n; $i++) {
            $select[] = "SUM(CASE WHEN $at >= :d$i AND $at < :d" . ($i + 1) . " THEN 1 ELSE 0 END) AS c$i";
        }

        $qb = $this->em->createQueryBuilder()
            ->select(...$select)
            ->from(Appointment::class, 'e')
            ->andWhere('e.deletedAt IS NULL')
            ->andWhere('e.status = :completed')
            ->andWhere("$at >= :d0")
            ->andWhere("$at < :d$n")
            ->setParameter('completed', AppointmentStatus::COMPLETED->value);
        $this->bindBounds($qb, $bounds);

        return $qb->getQuery();
    }

    // ----- Breakdowns (by consultation time) -----

    /**
     * Appointments whose consultation time falls in [from, to), by status.
     *
     * @return array<string,int> status => count
     */
    public function statusBreakdown(DateTimeImmutable $from, DateTimeImmutable $to): array
    {
        $out = [];
        foreach ($this->statusBreakdownQuery($from, $to)->getScalarResult() as $row) {
            $status       = $row['status'] instanceof AppointmentStatus ? $row['status']->value : (string) $row['status'];
            $out[$status] = (int) $row['n'];
        }

        return $out;
    }

    public function statusBreakdownQuery(DateTimeImmutable $from, DateTimeImmutable $to): Query
    {
        $qb = $this->em->createQueryBuilder()
            ->select('e.status AS status', 'COUNT(e.id) AS n')
            ->from(Appointment::class, 'e')
            ->andWhere('e.deletedAt IS NULL')
            ->andWhere('e.scheduledAt >= :from')
            ->andWhere('e.scheduledAt < :to')
            ->groupBy('e.status')
            ->setParameter('from', $this->at($from))
            ->setParameter('to', $this->at($to));
        $this->onlyBookings($qb, 'e');

        return $qb->getQuery();
    }

    /**
     * The busiest specialties by consultations scheduled in [from, to):
     * bookings, completed, and revenue (paid, net of refunds).
     *
     * Spellings that differ only in case or spacing ("Cardiology",
     * "cardiology ") count as one specialty — the grouping the reference-data
     * list uses ({@see ReferenceItem::keyOf()}) — named by the spelling most
     * of its bookings carry.
     *
     * @return list<array{specialty:string, bookings:int, completed:int, revenue:string}>
     */
    public function topSpecialties(DateTimeImmutable $from, DateTimeImmutable $to, int $limit = 6): array
    {
        $merged = [];
        // Rows arrive busiest first, so a key's first spelling is its most booked.
        foreach ($this->topSpecialtiesQuery($from, $to, self::SPELLINGS_SCANNED)->getScalarResult() as $r) {
            $key = ReferenceItem::keyOf((string) $r['specialty']);
            $row = $merged[$key] ?? [
                'specialty' => ReferenceItem::normaliseLabel((string) $r['specialty']),
                'bookings'  => 0,
                'completed' => 0,
                'revenue'   => '0.00',
            ];
            $row['bookings']  += (int) $r['bookings'];
            $row['completed'] += (int) $r['completed'];
            $row['revenue']    = bcadd($row['revenue'], self::money($r['revenue'] ?? null), 2);
            $merged[$key]      = $row;
        }
        $rows = array_values($merged);
        usort($rows, static fn (array $a, array $b): int => [$b['bookings'], $a['specialty']] <=> [$a['bookings'], $b['specialty']]);

        return array_slice($rows, 0, max(1, min(20, $limit)));
    }

    public function topSpecialtiesQuery(DateTimeImmutable $from, DateTimeImmutable $to, int $limit = 6): Query
    {
        $qb = $this->em->createQueryBuilder()
            ->select(
                's.specialty AS specialty',
                'COUNT(e.id) AS bookings',
                'SUM(CASE WHEN e.status = :completed THEN 1 ELSE 0 END) AS completed',
                'SUM(CASE WHEN e.paymentStatus = :paid THEN e.amount - COALESCE(e.refundedAmount, 0) ELSE 0 END) AS revenue',
            )
            ->from(Appointment::class, 'e')
            ->join('e.specialist', 's')
            ->andWhere('e.deletedAt IS NULL')
            ->andWhere('e.scheduledAt >= :from')
            ->andWhere('e.scheduledAt < :to')
            ->groupBy('s.specialty')
            ->orderBy('bookings', 'DESC')
            ->addOrderBy('specialty', 'ASC')
            ->setMaxResults(max(1, min(self::SPELLINGS_SCANNED, $limit)))
            ->setParameter('completed', AppointmentStatus::COMPLETED->value)
            ->setParameter('paid', 'paid')
            ->setParameter('from', $this->at($from))
            ->setParameter('to', $this->at($to));
        $this->onlyBookings($qb, 'e');

        return $qb->getQuery();
    }

    /**
     * The doctors with the most consultations scheduled in [from, to):
     * bookings, consultations held (completed), revenue (paid, net of
     * refunds), missed consultations they didn't attend (no_show doctor or
     * both) and ones the patient missed, with their overall rating.
     *
     * @return list<array{id:string, name:string, specialty:string, photo_url:?string, rating:string, reviews_count:int, bookings:int, consultations:int, revenue:string, doctor_no_shows:int, patient_no_shows:int}>
     */
    public function topDoctors(DateTimeImmutable $from, DateTimeImmutable $to, int $limit = 5): array
    {
        return array_map(static fn (array $r): array => [
            'id'               => (string) $r['id'],
            'name'             => (string) $r['name'],
            'specialty'        => (string) $r['specialty'],
            'photo_url'        => isset($r['photo_url']) && $r['photo_url'] !== '' ? (string) $r['photo_url'] : null,
            'rating'           => number_format((float) ($r['rating'] ?? 0), 2, '.', ''),
            'reviews_count'    => (int) ($r['reviews_count'] ?? 0),
            'bookings'         => (int) $r['bookings'],
            'consultations'    => (int) $r['consultations'],
            'revenue'          => self::money($r['revenue'] ?? null),
            'doctor_no_shows'  => (int) $r['doctor_no_shows'],
            'patient_no_shows' => (int) $r['patient_no_shows'],
        ], $this->topDoctorsQuery($from, $to, $limit)->getScalarResult());
    }

    public function topDoctorsQuery(DateTimeImmutable $from, DateTimeImmutable $to, int $limit = 5): Query
    {
        $qb = $this->em->createQueryBuilder()
            ->select(
                's.id AS id',
                's.name AS name',
                's.specialty AS specialty',
                's.photoUrl AS photo_url',
                's.rating AS rating',
                's.reviewsCount AS reviews_count',
                'COUNT(e.id) AS bookings',
                'SUM(CASE WHEN e.status = :completed THEN 1 ELSE 0 END) AS consultations',
                'SUM(CASE WHEN e.paymentStatus = :paid THEN e.amount - COALESCE(e.refundedAmount, 0) ELSE 0 END) AS revenue',
                'SUM(CASE WHEN e.status = :missed AND e.noShow IN (:doctor_absent) THEN 1 ELSE 0 END) AS doctor_no_shows',
                'SUM(CASE WHEN e.status = :missed AND e.noShow = :ns_patient THEN 1 ELSE 0 END) AS patient_no_shows',
            )
            ->from(Appointment::class, 'e')
            ->join('e.specialist', 's')
            ->andWhere('e.deletedAt IS NULL')
            ->andWhere('e.scheduledAt >= :from')
            ->andWhere('e.scheduledAt < :to')
            // Grouped by the primary key: the other doctor columns depend on it.
            ->groupBy('s.id')
            ->orderBy('consultations', 'DESC')
            ->addOrderBy('bookings', 'DESC')
            ->addOrderBy('revenue', 'DESC')
            ->setMaxResults(max(1, min(20, $limit)))
            ->setParameter('completed', AppointmentStatus::COMPLETED->value)
            ->setParameter('missed', AppointmentStatus::MISSED->value)
            ->setParameter('paid', 'paid')
            ->setParameter('doctor_absent', ['doctor', 'both'])
            ->setParameter('ns_patient', 'patient')
            ->setParameter('from', $this->at($from))
            ->setParameter('to', $this->at($to));
        $this->onlyBookings($qb, 'e');

        return $qb->getQuery();
    }

    // ----- Live now -----

    /**
     * Open bookings (pending / confirmed / rescheduled) whose call could be
     * running now — started up to `$lookbackMinutes` ago, or starting within
     * `$earlyMinutes` (patients may join early) — for the presence check.
     * Newest first, so with `$limit` it is the oldest (most likely ended but
     * never closed) that are left out, never a call starting about now.
     *
     * @return list<Appointment>
     */
    public function liveCandidates(DateTimeImmutable $now, int $lookbackMinutes = 240, int $earlyMinutes = 15, int $limit = 50): array
    {
        return $this->liveCandidatesQuery($now, $lookbackMinutes, $earlyMinutes, $limit)->getResult();
    }

    public function liveCandidatesQuery(DateTimeImmutable $now, int $lookbackMinutes = 240, int $earlyMinutes = 15, int $limit = 50): Query
    {
        $now = $this->at($now);

        return $this->em->createQueryBuilder()
            ->select('e', 's', 'p')
            ->from(Appointment::class, 'e')
            ->join('e.specialist', 's')
            ->join('e.patient', 'p')
            ->andWhere('e.deletedAt IS NULL')
            ->andWhere('e.status IN (:open)')
            ->andWhere('e.scheduledAt >= :since')
            ->andWhere('e.scheduledAt <= :until')
            ->orderBy('e.scheduledAt', 'DESC')
            ->addOrderBy('e.id', 'DESC')
            ->setMaxResults(max(1, min(200, $limit)))
            ->setParameter('open', self::openStatuses())
            ->setParameter('since', $now->modify('-' . max(0, $lookbackMinutes) . ' minutes'))
            ->setParameter('until', $now->modify('+' . max(0, $earlyMinutes) . ' minutes'))
            ->getQuery();
    }

    /**
     * Open bookings starting in (now, until], soonest first, leaving out
     * `$excludeIds` (the ones already in a call — shown as in progress).
     *
     * @param list<string> $excludeIds
     * @return list<Appointment>
     */
    public function startingSoon(DateTimeImmutable $now, DateTimeImmutable $until, int $limit = 10, array $excludeIds = []): array
    {
        return $this->startingSoonQuery($now, $until, $excludeIds)
            ->setMaxResults(max(1, min(50, $limit)))
            ->getResult();
    }

    /** @param list<string> $excludeIds */
    public function startingSoonQuery(DateTimeImmutable $now, DateTimeImmutable $until, array $excludeIds = []): Query
    {
        return $this->startingSoonBuilder($now, $until, $excludeIds)
            ->select('e', 's', 'p')
            ->join('e.specialist', 's')
            ->join('e.patient', 'p')
            ->orderBy('e.scheduledAt', 'ASC')
            ->addOrderBy('e.id', 'ASC')
            ->getQuery();
    }

    /** @param list<string> $excludeIds */
    public function countStartingSoon(DateTimeImmutable $now, DateTimeImmutable $until, array $excludeIds = []): int
    {
        return (int) $this->startingSoonCountQuery($now, $until, $excludeIds)->getSingleScalarResult();
    }

    /** @param list<string> $excludeIds */
    public function startingSoonCountQuery(DateTimeImmutable $now, DateTimeImmutable $until, array $excludeIds = []): Query
    {
        return $this->startingSoonBuilder($now, $until, $excludeIds)->select('COUNT(e.id)')->getQuery();
    }

    // ----- Needs attention (money held, payouts) -----

    /**
     * Payout requests waiting for approval: how many, and their total in
     * `$currency`.
     *
     * @return array{count:int, amount:string}
     */
    public function pendingPayouts(string $currency): array
    {
        $r = $this->pendingPayoutsQuery($currency)->getSingleResult();

        return ['count' => (int) ($r['n'] ?? 0), 'amount' => self::money($r['amount'] ?? null)];
    }

    public function pendingPayoutsQuery(string $currency): Query
    {
        return $this->em->createQueryBuilder()
            ->select('COUNT(e.id) AS n', 'SUM(CASE WHEN e.currency = :currency THEN e.amount ELSE 0 END) AS amount')
            ->from(Payout::class, 'e')
            ->andWhere('e.status = :pending')
            ->setParameter('pending', Payout::STATUS_PENDING)
            ->setParameter('currency', strtoupper($currency))
            ->getQuery();
    }

    /**
     * Wallet top-ups paid but held for support (amount/currency mismatch): how
     * many, and their total in `$currency`.
     *
     * @return array{count:int, amount:string}
     */
    public function heldTopups(string $currency): array
    {
        $r = $this->heldTopupsQuery($currency)->getSingleResult();

        return ['count' => (int) ($r['n'] ?? 0), 'amount' => self::money($r['amount'] ?? null)];
    }

    public function heldTopupsQuery(string $currency): Query
    {
        return $this->em->createQueryBuilder()
            ->select('COUNT(e.id) AS n', 'SUM(CASE WHEN e.currency = :currency THEN e.amount ELSE 0 END) AS amount')
            ->from(WalletTransaction::class, 'e')
            ->andWhere('e.type = :topup')
            ->andWhere('e.status = :review')
            ->setParameter('topup', WalletTransaction::TYPE_TOPUP)
            ->setParameter('review', WalletTransaction::STATUS_REVIEW)
            ->setParameter('currency', strtoupper($currency))
            ->getQuery();
    }

    /**
     * Card payments paid but held for support (couldn't be used or credited
     * automatically): how many, and their total in `$currency`.
     *
     * @return array{count:int, amount:string}
     */
    public function cardPaymentsInReview(string $currency): array
    {
        $r = $this->cardPaymentsInReviewQuery($currency)->getSingleResult();

        return ['count' => (int) ($r['n'] ?? 0), 'amount' => self::money($r['amount'] ?? null)];
    }

    public function cardPaymentsInReviewQuery(string $currency): Query
    {
        return $this->em->createQueryBuilder()
            ->select('COUNT(e.id) AS n', 'SUM(CASE WHEN e.currency = :currency THEN e.amount ELSE 0 END) AS amount')
            ->from(PaymentIntent::class, 'e')
            ->andWhere('e.status = :review')
            ->setParameter('review', PaymentIntent::STATUS_REVIEW)
            ->setParameter('currency', strtoupper($currency))
            ->getQuery();
    }

    // ----- Recent activity -----

    /**
     * The latest audit events, newest first, leaving out routine reads
     * ({@see QUIET_AUDIT_ACTIONS}).
     *
     * @return list<AuditEvent>
     */
    public function recentActivity(int $limit = 8): array
    {
        return $this->recentActivityQuery($limit)->getResult();
    }

    public function recentActivityQuery(int $limit = 8): Query
    {
        return $this->em->createQueryBuilder()
            ->select('e')
            ->from(AuditEvent::class, 'e')
            ->andWhere('e.action NOT IN (:quiet)')
            ->orderBy('e.createdAt', 'DESC')
            ->addOrderBy('e.id', 'DESC')
            ->setMaxResults(max(1, min(50, $limit)))
            ->setParameter('quiet', self::QUIET_AUDIT_ACTIONS)
            ->getQuery();
    }

    // ----- helpers -----

    /** @param list<string> $excludeIds */
    private function startingSoonBuilder(DateTimeImmutable $now, DateTimeImmutable $until, array $excludeIds = []): QueryBuilder
    {
        $qb = $this->em->createQueryBuilder()
            ->from(Appointment::class, 'e')
            ->andWhere('e.deletedAt IS NULL')
            ->andWhere('e.status IN (:open)')
            ->andWhere('e.scheduledAt > :now')
            ->andWhere('e.scheduledAt <= :until')
            ->setParameter('open', self::openStatuses())
            ->setParameter('now', $this->at($now))
            ->setParameter('until', $this->at($until));
        $excludeIds = array_values(array_unique(array_filter($excludeIds, static fn (mixed $id): bool => is_string($id) && $id !== '')));
        if ($excludeIds !== []) {
            $qb->andWhere('e.id NOT IN (:live)')->setParameter('live', $excludeIds);
        }

        return $qb;
    }

    /**
     * Leave out follow-up proposals that never became bookings (the analytics
     * rule): still open (`proposed`), or a doctor's proposal that closed
     * cancelled and unpaid (declined / withdrawn / expired).
     */
    private function onlyBookings(QueryBuilder $qb, string $alias): void
    {
        $qb->andWhere("$alias.status <> :ob_proposed")
            ->andWhere("$alias.proposedBy IS NULL OR $alias.proposedBy <> :ob_doctor OR $alias.status <> :cancelled OR $alias.paymentStatus <> :ob_unpaid")
            ->setParameter('ob_proposed', AppointmentStatus::PROPOSED->value)
            ->setParameter('ob_doctor', 'doctor')
            ->setParameter('cancelled', AppointmentStatus::CANCELLED->value)
            ->setParameter('ob_unpaid', 'unpaid');
    }

    private function bindWindows(QueryBuilder $qb, DateTimeImmutable $from, DateTimeImmutable $to, DateTimeImmutable $prevFrom, DateTimeImmutable $prevTo): void
    {
        $qb->setParameter('cf', $this->at($from))
            ->setParameter('ct', $this->at($to))
            ->setParameter('pf', $this->at($prevFrom))
            ->setParameter('pt', $this->at($prevTo));
    }

    /** @param list<DateTimeImmutable> $bounds */
    private function bindBounds(QueryBuilder $qb, array $bounds): void
    {
        foreach (array_values($bounds) as $i => $bound) {
            $qb->setParameter('d' . $i, $this->at($bound));
        }
    }

    /** The same instant in the process zone — what the naive timestamp columns hold. */
    private function at(DateTimeImmutable $instant): DateTimeImmutable
    {
        return $instant->setTimezone(new DateTimeZone(date_default_timezone_get()));
    }

    /** @return list<string> pending, confirmed, rescheduled */
    private static function openStatuses(): array
    {
        return array_map(static fn (AppointmentStatus $s): string => $s->value, AppointmentStatus::openBookings());
    }

    private static function money(mixed $value): string
    {
        if ($value === null || $value === '') {
            return '0.00';
        }

        return bcadd((string) $value, '0', 2);
    }
}
