<?php

declare(strict_types=1);

namespace App\Infrastructure\Service;

use App\Domain\Appointment\AppointmentLifecycle;
use App\Domain\Entity\Appointment;
use App\Domain\Entity\SessionMetric;
use App\Domain\Entity\TranscriptSegment;
use App\Domain\Enum\AppointmentStatus;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Settings\BookingSettings;
use App\Domain\Settings\WebUrls;
use App\Infrastructure\Email\EmailTemplates;
use App\Infrastructure\Email\MailService;
use DateTimeImmutable;
use Doctrine\ORM\EntityManagerInterface;
use Doctrine\ORM\Query;

/**
 * Closes past consultations nobody closed, from the reminders cron (next to
 * {@see ConsultationCompleter}, with the same compare-and-set, audit and
 * quiet-backlog rules). Idempotent: a closed visit is never a candidate again,
 * and every refund posts under a fixed reference.
 *
 *  a) Took place: any pending, rescheduled or confirmed visit whose slot ended
 *     more than `missed_after_hours` ago WITH proof it took place
 *     (ConsultationCompleter's evidence) → completed (closure_reason
 *     auto_completed; an unconfirmed one is audited
 *     `appointment.auto_completed_unconfirmed`).
 *  b) Never confirmed: a pending or rescheduled visit whose slot ended more
 *     than max(`unconfirmed_expiry_minutes_after_end`,
 *     AppointmentLifecycle::CONFIRM_GRACE_MINUTES) ago — never while the
 *     doctor may still confirm it — with no proof → cancelled (closure_reason
 *     expired_unconfirmed) and refunded in full, guest fees included
 *     (`appt_refund_<id>`); both sides told. One both sides opened the call
 *     of (both first-join stamps in its presence window) is left alone: shown
 *     "Being finalised", completed on proof or resolved by the back office.
 *  c) Missed: a confirmed visit whose slot ended more than
 *     `missed_after_hours` ago with no proof → MISSED, `no_show` doctor |
 *     patient | both from each side's presence inside [start − 15 min,
 *     end + 30 min] (call samples, transcript lines, the first-join stamps;
 *     {@see AppointmentLifecycle::noShowParty()}). Refund
 *     (`appt_noshow_refund_<id>`): the doctor didn't come → 100%; the patient
 *     didn't → `noshow_patient_refund_pct` of the fee (the doctor earns the
 *     rest); neither → `noshow_both_refund_pct` (the doctor earns nothing);
 *     guest fees always go back. Both sides told; a doctor reaching
 *     `doctor_noshow_alert_threshold` no-shows in 30 days alerts staff
 *     (specialists.manage). Overlapping presence with no proof is left open
 *     for the back office ("needs attention").
 *
 * Nothing is closed while someone is in its call. Visits that started more
 * than NOTIFY_WITHIN_DAYS ago close quietly (audited, refunded, no messages
 * and no wallet receipt). Each pass pages through all its candidates with a
 * keyset cursor, and a failure in one pass never stops the next. A failure
 * that closes the entity manager does stop the run: the cron then runs again
 * on a fresh one, skipping the visits that failed ({@see runWithRetries()}).
 */
final class PastAppointmentCloser
{
    /** Older backlog closes quietly, as in ConsultationCompleter. */
    public const NOTIFY_WITHIN_DAYS = ConsultationCompleter::NOTIFY_WITHIN_DAYS;
    /** Re-runs on a fresh entity manager after a failure closed it ({@see runWithRetries()}). */
    public const RETRIES = 3;
    /** Visits read per page (each pass pages on with a keyset cursor). */
    private const BATCH = 200;
    /** Pages per pass per run — bounds one run (the next run takes the rest). */
    private const MAX_PAGES = 50;

    public function __construct(
        private readonly EntityManagerInterface $em,
        private readonly AppointmentRepository $appointments,
        private readonly ConsultationCompleter $completer,
        private readonly AppointmentPaymentService $payments,
        private readonly BookingSettings $settings,
        private readonly AuditLogger $audit,
        private readonly PatientNotifier $patientNotifier,
        private readonly StaffNotifier $staffNotifier,
        private readonly MailService $mail,
        private readonly PricingService $pricing,
        private readonly CallPresence $presence,
    ) {
    }

    /**
     * One cron pass: a), b) then c). `$skipIds` are left out of every pass
     * (visits that failed in an earlier attempt of this cron run); the ids
     * that fail now are returned in `failed_ids`.
     *
     * @param list<string> $skipIds
     * @return array{completed:int, completed_quiet:int, kinds:array<string,int>, expired:int, missed:array{doctor:int, patient:int, both:int}, ambiguous:int, quiet:int, refunded:string, alerts:int, errors:int, failed_ids:list<string>}
     */
    public function run(?DateTimeImmutable $now = null, array $skipIds = []): array
    {
        $now ??= new DateTimeImmutable();
        $out = [
            'completed'       => 0,
            'completed_quiet' => 0,
            'kinds'           => [],
            'expired'         => 0,
            'missed'          => ['doctor' => 0, 'patient' => 0, 'both' => 0],
            'ambiguous'       => 0,
            'quiet'           => 0,
            'refunded'        => '0.00',
            'alerts'          => 0,
            'errors'          => 0,
            'failed_ids'      => [],
        ];

        // A failure in one pass never stops the others: (b) and (c) still run
        // (while the entity manager is usable), so one bad row can't stall
        // expiries, refunds and missed-marking for good.
        try {
            $done = $this->completer->autoCompleteOverdue(
                $now,
                $this->settings->get('missed_after_hours'),
                [AppointmentStatus::PENDING, AppointmentStatus::RESCHEDULED, AppointmentStatus::CONFIRMED],
                $skipIds,
            );
            $out['completed']       = $done['completed'];
            $out['completed_quiet'] = $done['quiet'];
            $out['kinds']           = $done['kinds'];
            $out['errors']         += $done['errors'] ?? 0;
            $out['failed_ids']      = $done['failed_ids'] ?? [];
        } catch (\Throwable $e) {
            ++$out['errors'];
            error_log('[past-appointments] the completion pass failed: ' . $e::class . ': ' . $e->getMessage());
        }

        foreach (['expireUnconfirmed', 'markMissed'] as $pass) {
            if (!$this->em->isOpen()) {
                break;
            }
            try {
                $this->{$pass}($now, $out, $skipIds);
            } catch (\Throwable $e) {
                ++$out['errors'];
                error_log('[past-appointments] the ' . $pass . ' pass failed: ' . $e::class . ': ' . $e->getMessage());
            }
        }

        return $out;
    }

    /**
     * The cron's entry point around {@see run()}. Doctrine closes the entity
     * manager on any exception inside a transaction (an audit insert or a
     * flush failing on one row), which stops the rest of that run — and the
     * next run would meet the same oldest row first, stalling for good. So
     * while a run leaves the entity manager closed, run again on a fresh one
     * (`$attempt` builds it), skipping every visit that has failed so far — at
     * most `$retries` times.
     *
     * The attempts' results are added up: closed visits are never picked
     * twice, so the counts and refunds don't overlap; `ambiguous` is the most
     * any attempt saw (each sees the same rows again); `failed_ids` lists each
     * failed visit once; `retries` is how many re-runs it took.
     *
     * @param callable(list<string>, int): array{0: array<string,mixed>, 1: bool} $attempt
     *        one run() skipping these visits — attempt 0 on the current entity
     *        manager, later ones on a fresh one — returning [its result,
     *        whether the entity manager is still open]
     * @return array<string,mixed> run()'s result, plus `retries`
     */
    public static function runWithRetries(callable $attempt, int $retries = self::RETRIES): array
    {
        $total = null;
        $skip  = [];
        for ($try = 0; ; ++$try) {
            [$result, $open] = $attempt($skip, $try);
            $skip  = array_values(array_unique([...$skip, ...($result['failed_ids'] ?? [])]));
            $total = $total === null ? $result : self::addUp($total, $result);
            if ($open || $try >= $retries) {
                break;
            }
        }
        $total['failed_ids'] = $skip;
        $total['retries']    = $try;

        return $total;
    }

    /**
     * Two attempts' results as one (see {@see runWithRetries()}).
     *
     * @param array<string,mixed> $a
     * @param array<string,mixed> $b
     * @return array<string,mixed>
     */
    private static function addUp(array $a, array $b): array
    {
        foreach (['completed', 'completed_quiet', 'expired', 'quiet', 'alerts', 'errors'] as $key) {
            $a[$key] = ($a[$key] ?? 0) + ($b[$key] ?? 0);
        }
        foreach ($b['kinds'] ?? [] as $kind => $count) {
            $a['kinds'][$kind] = ($a['kinds'][$kind] ?? 0) + $count;
        }
        ksort($a['kinds']);
        foreach ($b['missed'] ?? [] as $party => $count) {
            $a['missed'][$party] = ($a['missed'][$party] ?? 0) + $count;
        }
        $a['ambiguous'] = max($a['ambiguous'] ?? 0, $b['ambiguous'] ?? 0);
        $a['refunded']  = bcadd((string) ($a['refunded'] ?? '0.00'), (string) ($b['refunded'] ?? '0.00'), 2);

        return $a;
    }

    /**
     * How long after its end an unconfirmed request is expired: the
     * `unconfirmed_expiry_minutes_after_end` setting, but never inside the
     * doctor's confirm grace (AppointmentLifecycle::CONFIRM_GRACE_MINUTES) —
     * a request stays confirmable, and counted as pending, until then.
     */
    public function unconfirmedExpiryMinutes(): int
    {
        return max($this->settings->get('unconfirmed_expiry_minutes_after_end'), AppointmentLifecycle::CONFIRM_GRACE_MINUTES);
    }

    // ----- b) Never confirmed -----

    /**
     * @param array<string,mixed> $out
     * @param list<string>        $skipIds
     */
    private function expireUnconfirmed(DateTimeImmutable $now, array &$out, array $skipIds = []): void
    {
        $cutoff = $now->modify('-' . $this->unconfirmedExpiryMinutes() . ' minutes');
        $after  = null;
        for ($page = 0; $page < self::MAX_PAGES; ++$page) {
            /** @var list<Appointment> $due */
            $due   = $this->expiredUnconfirmedQuery($cutoff, $after, $skipIds)->getResult();
            $after = self::cursorAfter($due);
            if (!$this->expirePage($due, $now, $out) || count($due) < self::BATCH) {
                return;
            }
        }
    }

    /**
     * Expire one page of never-confirmed requests. False when the entity
     * manager closed (stop the pass).
     *
     * @param list<Appointment>   $due
     * @param array<string,mixed> $out
     */
    private function expirePage(array $due, DateTimeImmutable $now, array &$out): bool
    {
        foreach ($due as $appointment) {
            if ($this->someoneInCall($appointment)) {
                continue;
            }
            $quiet = $this->isQuiet($appointment, $now);
            try {
                $from    = $appointment->getStatus();
                $refund  = null;
                $claimed = $this->em->wrapInTransaction(function () use ($appointment, $from, $quiet, &$refund): bool {
                    if (!$this->claim($appointment, $from, AppointmentStatus::CANCELLED, 'expired_unconfirmed', null)) {
                        return false;
                    }
                    // The quiet backlog sends no wallet receipt either.
                    $txn    = $this->payments->refundForCancellation($appointment, !$quiet);
                    $refund = $txn?->getAmount();
                    $this->audit->record('System', 'system', 'appointment.expired_unconfirmed', $appointment->getId(), 'appointment', $appointment->getId(), [
                        'was'    => $from->value,
                        'refund' => $refund ?? '0.00',
                    ]);
                    $this->em->flush();

                    return true;
                });
            } catch (\Throwable $e) {
                $this->failed($e, $appointment, $out);
                if (!$this->em->isOpen()) {
                    return false;
                }
                continue;
            }
            if (!$claimed) {
                continue; // confirmed, moved or cancelled a moment ago
            }
            ++$out['expired'];
            $out['refunded'] = bcadd($out['refunded'], $refund ?? '0.00', 2);
            if ($quiet) {
                ++$out['quiet'];
                continue;
            }
            $this->notifyNotConfirmed($appointment, $refund);
        }

        return true;
    }

    // ----- c) Missed -----

    /**
     * Pages through every candidate (a keyset cursor on start time and id), so
     * rows left open — overlapping presence without proof, a visit still in
     * its call, a failure — never crowd newer ones out of the batch.
     *
     * @param array<string,mixed> $out
     * @param list<string>        $skipIds
     */
    private function markMissed(DateTimeImmutable $now, array &$out, array $skipIds = []): void
    {
        $cutoff = $now->modify('-' . $this->settings->get('missed_after_hours') . ' hours');
        $after  = null;
        for ($page = 0; $page < self::MAX_PAGES; ++$page) {
            /** @var list<Appointment> $due */
            $due   = $this->missedCandidatesQuery($cutoff, $after, $skipIds)->getResult();
            $after = self::cursorAfter($due);
            if ($due === [] || !$this->missPage($due, $now, $out) || count($due) < self::BATCH) {
                return;
            }
        }
    }

    /**
     * Mark one page of confirmed visits with no proof missed. False when the
     * entity manager closed (stop the pass).
     *
     * @param list<Appointment>   $due
     * @param array<string,mixed> $out
     */
    private function missPage(array $due, DateTimeImmutable $now, array &$out): bool
    {
        $ids      = array_map(static fn (Appointment $a): string => $a->getId(), $due);
        $evidence = $this->completer->evidenceKinds($ids);
        $spans    = $this->presenceSpans($ids);

        foreach ($due as $appointment) {
            $id = $appointment->getId();
            if (($evidence[$id] ?? []) !== [] || $this->someoneInCall($appointment)) {
                continue; // proof turned up meanwhile (a) closes it next run / still in the call
            }
            $party = AppointmentLifecycle::noShowParty(
                $this->span($appointment, 'doctor', $spans[$id]['doctor'] ?? null),
                $this->span($appointment, 'patient', $spans[$id]['patient'] ?? null),
                $appointment->getScheduledAt(),
            );
            if ($party === null) {
                ++$out['ambiguous']; // they overlapped without proof — the back office resolves it
                continue;
            }

            $quiet = $this->isQuiet($appointment, $now);
            try {
                $refund  = '0.00';
                $pct     = $this->refundPercent($party);
                $claimed = $this->em->wrapInTransaction(function () use ($appointment, $party, $pct, $quiet, &$refund): bool {
                    if (!$this->claim($appointment, AppointmentStatus::CONFIRMED, AppointmentStatus::MISSED, 'no_show', $party)) {
                        return false;
                    }
                    // The quiet backlog sends no wallet receipt either.
                    $refund = $this->payments->refundPart(
                        $appointment,
                        self::noShowRefund($appointment, $pct),
                        self::noShowRefundReference($appointment),
                        'Refund for a missed consultation with ' . $appointment->getSpecialist()->getName(),
                        !$quiet,
                    );
                    $this->audit->record('System', 'system', 'appointment.missed', $appointment->getId(), 'appointment', $appointment->getId(), [
                        'no_show'    => $party,
                        'refund_pct' => $pct,
                        'refund'     => $refund,
                        'guest_fees' => $appointment->guestFeesTotal(),
                    ]);
                    $this->em->flush();

                    return true;
                });
            } catch (\Throwable $e) {
                $this->failed($e, $appointment, $out);
                if (!$this->em->isOpen()) {
                    return false;
                }
                continue;
            }
            if (!$claimed) {
                continue;
            }
            ++$out['missed'][$party];
            $out['refunded'] = bcadd($out['refunded'], $refund, 2);
            if ($quiet) {
                ++$out['quiet'];
                continue;
            }
            if ($this->announceMissed($appointment, $party, $refund, $now)) {
                ++$out['alerts'];
            }
        }

        return true;
    }

    /**
     * The keyset cursor after a page: [start time, id] of its last row, as
     * read (before closing it could reload a moved one), or null when empty.
     *
     * @param list<Appointment> $page
     * @return array{0:DateTimeImmutable, 1:string}|null
     */
    private static function cursorAfter(array $page): ?array
    {
        $last = $page === [] ? null : $page[count($page) - 1];

        return $last === null ? null : [$last->getScheduledAt(), $last->getId()];
    }

    /**
     * What a missed consultation refunds: every guest fee, plus `$percent` of
     * the rest (the consultation fee) — never more than was paid.
     */
    public static function noShowRefund(Appointment $appointment, int $percent): string
    {
        return AppointmentLifecycle::partialRefund($appointment, $percent);
    }

    /** The no-show refund's ledger reference (one per appointment). */
    public static function noShowRefundReference(Appointment $appointment): string
    {
        return 'appt_noshow_refund_' . $appointment->getId();
    }

    /** The refund percentage of the consultation fee for who didn't come (the doctor: always 100). */
    public function refundPercent(string $noShow): int
    {
        return match ($noShow) {
            'doctor'  => 100,
            'patient' => $this->settings->get('noshow_patient_refund_pct'),
            default   => $this->settings->get('noshow_both_refund_pct'),
        };
    }

    // ----- Queries (public so their DQL compiles in the offline tests) -----

    /**
     * Pending / rescheduled, not deleted, slot ended before `$cutoff`, no
     * proof, and not one both sides opened the call of (both first-join
     * stamps inside its presence window: shown "Being finalised" and left for
     * proof or the back office) — oldest first, after the `$after` cursor
     * ([start, id] of the previous page's last row), leaving out `$skipIds`.
     *
     * @param array{0:DateTimeImmutable, 1:string}|null $after
     * @param list<string>                              $skipIds
     */
    public function expiredUnconfirmedQuery(DateTimeImmutable $cutoff, ?array $after = null, array $skipIds = []): Query
    {
        $qb = $this->em->createQueryBuilder()
            ->select('a', 's')
            ->from(Appointment::class, 'a')
            ->join('a.specialist', 's')
            ->andWhere('a.status IN (:requests)')
            ->andWhere('a.deletedAt IS NULL')
            // Strictly after the doctor's confirm window (they may confirm up to its last second).
            ->andWhere("DATE_ADD(a.scheduledAt, s.slotMinutes, 'minute') < :cutoff")
            ->andWhere('NOT ' . $this->completer->evidenceExistsDql('a'))
            ->andWhere('NOT (' . self::stampInWindowDql('doctorFirstJoinedAt') . ' AND ' . self::stampInWindowDql('patientFirstJoinedAt') . ')')
            ->setParameter('requests', [AppointmentStatus::PENDING->value, AppointmentStatus::RESCHEDULED->value])
            ->setParameter('cutoff', $cutoff);
        ConsultationCompleter::excludeIds($qb, $skipIds);

        return $this->completer->bindEvidence(self::page($qb, $after)->getQuery());
    }

    /**
     * Confirmed, not deleted, slot ended by `$cutoff`, no proof — oldest
     * first, after the `$after` cursor ([start, id] of the previous page's
     * last row), leaving out `$skipIds`.
     *
     * @param array{0:DateTimeImmutable, 1:string}|null $after
     * @param list<string>                              $skipIds
     */
    public function missedCandidatesQuery(DateTimeImmutable $cutoff, ?array $after = null, array $skipIds = []): Query
    {
        $qb = $this->em->createQueryBuilder()
            ->select('a', 's')
            ->from(Appointment::class, 'a')
            ->join('a.specialist', 's')
            ->andWhere('a.status = :confirmed')
            ->andWhere('a.deletedAt IS NULL')
            ->andWhere("DATE_ADD(a.scheduledAt, s.slotMinutes, 'minute') <= :cutoff")
            ->andWhere('NOT ' . $this->completer->evidenceExistsDql('a'))
            ->setParameter('confirmed', AppointmentStatus::CONFIRMED->value)
            ->setParameter('cutoff', $cutoff);
        ConsultationCompleter::excludeIds($qb, $skipIds);

        return $this->completer->bindEvidence(self::page($qb, $after)->getQuery());
    }

    /**
     * Oldest first by (start, id), BATCH rows, after the keyset cursor.
     *
     * @param array{0:DateTimeImmutable, 1:string}|null $after
     */
    private static function page(\Doctrine\ORM\QueryBuilder $qb, ?array $after): \Doctrine\ORM\QueryBuilder
    {
        if ($after !== null) {
            $qb->andWhere('(a.scheduledAt > :afterAt OR (a.scheduledAt = :afterAt AND a.id > :afterId))')
                ->setParameter('afterAt', $after[0])
                ->setParameter('afterId', $after[1]);
        }

        return $qb->orderBy('a.scheduledAt', 'ASC')
            ->addOrderBy('a.id', 'ASC')
            ->setMaxResults(self::BATCH);
    }

    /** "(a.<stamp> is set and inside a's presence window)" — `a` joined to its specialist `s`. */
    private static function stampInWindowDql(string $field): string
    {
        return "(a.$field IS NOT NULL"
            . " AND a.$field >= DATE_SUB(a.scheduledAt, " . AppointmentLifecycle::PRESENCE_EARLY_MINUTES . ", 'minute')"
            . " AND a.$field <= DATE_ADD(DATE_ADD(a.scheduledAt, s.slotMinutes, 'minute'), " . AppointmentLifecycle::PRESENCE_LATE_MINUTES . ", 'minute'))";
    }

    /**
     * The compare-and-set that closes one visit: only while it is still
     * `$from` at the same start time (a racing confirm, reschedule or cancel
     * wins cleanly), recording why, who didn't come and when.
     */
    public function closeClaimQuery(string $appointmentId, AppointmentStatus $from, DateTimeImmutable $scheduledAt, AppointmentStatus $to, string $reason, ?string $noShow): Query
    {
        $qb = $this->em->createQueryBuilder()
            ->update(Appointment::class, 'a')
            ->set('a.status', ':to')
            ->set('a.closureReason', ':reason')
            ->set('a.closedAt', ':now')
            ->set('a.updatedAt', ':now')
            ->where('a.id = :id')
            ->andWhere('a.status = :from')
            ->andWhere('a.scheduledAt = :at')
            ->setParameter('to', $to->value)
            ->setParameter('reason', $reason)
            ->setParameter('now', new DateTimeImmutable())
            ->setParameter('id', $appointmentId)
            ->setParameter('from', $from->value)
            ->setParameter('at', $scheduledAt);
        if ($noShow !== null) {
            $qb->set('a.noShow', ':noShow')->setParameter('noShow', $noShow);
        }

        return $qb->getQuery();
    }

    /**
     * Each side's first and last sign of presence inside the presence window,
     * per appointment, from call samples and transcript lines.
     *
     * @param list<string> $ids
     * @return array<string, Query> kind => query (rows: id, role, first, last)
     */
    public function presenceQueries(array $ids): array
    {
        $queries = [];
        foreach (['metrics' => SessionMetric::class, 'transcript' => TranscriptSegment::class] as $kind => $entity) {
            $queries[$kind] = $this->em->createQuery(
                'SELECT pm.appointmentId AS id, pm.role AS role, MIN(pm.createdAt) AS first_at, MAX(pm.createdAt) AS last_at'
                . " FROM $entity pm, " . Appointment::class . ' pa JOIN pa.specialist ps'
                . ' WHERE pa.id = pm.appointmentId AND pm.appointmentId IN (:ids) AND pm.role IN (:roles)'
                . ' AND pm.createdAt >= DATE_SUB(pa.scheduledAt, ' . AppointmentLifecycle::PRESENCE_EARLY_MINUTES . ", 'minute')"
                . " AND pm.createdAt <= DATE_ADD(DATE_ADD(pa.scheduledAt, ps.slotMinutes, 'minute'), " . AppointmentLifecycle::PRESENCE_LATE_MINUTES . ", 'minute')"
                . ' GROUP BY pm.appointmentId, pm.role',
            )->setParameter('ids', $ids)->setParameter('roles', ['doctor', 'patient']);
        }

        return $queries;
    }

    /**
     * @param list<string> $ids
     * @return array<string, array<string, array{first:DateTimeImmutable, last:DateTimeImmutable}>> id => role => span
     */
    private function presenceSpans(array $ids): array
    {
        $out = [];
        foreach ($this->presenceQueries($ids) as $query) {
            foreach ($query->getScalarResult() as $row) {
                $id   = (string) $row['id'];
                $role = (string) $row['role'];
                try {
                    $first = new DateTimeImmutable((string) $row['first_at']);
                    $last  = new DateTimeImmutable((string) $row['last_at']);
                } catch (\Exception) {
                    continue;
                }
                $span = $out[$id][$role] ?? null;
                $out[$id][$role] = [
                    'first' => $span === null || $first < $span['first'] ? $first : $span['first'],
                    'last'  => $span === null || $last > $span['last'] ? $last : $span['last'],
                ];
            }
        }

        return $out;
    }

    /**
     * One side's presence span, widened by their first-join stamp when that
     * falls in the window.
     *
     * @param array{first:DateTimeImmutable, last:DateTimeImmutable}|null $span
     * @return array{first:?DateTimeImmutable, last:?DateTimeImmutable}
     */
    private function span(Appointment $appointment, string $role, ?array $span): array
    {
        $first = $span['first'] ?? null;
        $last  = $span['last'] ?? null;
        $stamp = $appointment->getFirstJoinedAt($role);
        if (AppointmentLifecycle::inPresenceWindow($appointment, $stamp)) {
            $first = $first === null || $stamp < $first ? $stamp : $first;
            $last  = $last === null || $stamp > $last ? $stamp : $last;
        }

        return ['first' => $first, 'last' => $last];
    }

    // ----- Helpers -----

    /** Run the compare-and-set; on success reload the stored state. */
    private function claim(Appointment $appointment, AppointmentStatus $from, AppointmentStatus $to, string $reason, ?string $noShow): bool
    {
        $claimed = (int) $this->closeClaimQuery($appointment->getId(), $from, $appointment->getScheduledAt(), $to, $reason, $noShow)->execute() === 1;
        // The UPDATE bypassed the unit of work — load the stored state back.
        $this->em->refresh($appointment);

        return $claimed;
    }

    private function someoneInCall(Appointment $appointment): bool
    {
        $p = $this->presence->forAppointment($appointment);

        return $p['doctor'] || $p['patient'] || $p['guests'] !== [];
    }

    private function isQuiet(Appointment $appointment, DateTimeImmutable $now): bool
    {
        return $appointment->getScheduledAt() < $now->modify('-' . self::NOTIFY_WITHIN_DAYS . ' days');
    }

    /**
     * Count and log one visit that failed to close, and remember it — a retry
     * on a fresh entity manager skips it ({@see runWithRetries()}).
     *
     * @param array<string,mixed> $out
     */
    private function failed(\Throwable $e, Appointment $appointment, array &$out): void
    {
        ++$out['errors'];
        $out['failed_ids'][] = $appointment->getId();
        error_log('[past-appointments] closing ' . $appointment->getId() . ' failed: ' . $e::class . ': ' . $e->getMessage());
    }

    /**
     * Staff (specialists.manage) are told when this doctor's no-shows in the
     * last 30 days reach doctor_noshow_alert_threshold (each one from then on).
     */
    private function alertRepeatedNoShows(Appointment $appointment, DateTimeImmutable $now): bool
    {
        $doctor    = $appointment->getSpecialist();
        $threshold = $this->settings->get('doctor_noshow_alert_threshold');
        $count     = $this->appointments->countDoctorNoShows(
            $doctor->getId(),
            $now->modify('-' . BookingSettings::DOCTOR_NOSHOW_WINDOW_DAYS . ' days'),
            $now,
        );
        if ($count < $threshold) {
            return false;
        }
        $this->staffNotifier->notifyPermission(
            'specialists.manage',
            'doctor_noshow',
            'Repeated doctor no-shows',
            sprintf('%s missed %d consultation%s in the last %d days.', $doctor->getName(), $count, $count === 1 ? '' : 's', BookingSettings::DOCTOR_NOSHOW_WINDOW_DAYS),
            '/specialists/' . $doctor->getId(),
        );

        return true;
    }

    // ----- Messages (generic: never the reason, a diagnosis or a medicine) -----

    private function notifyNotConfirmed(Appointment $appointment, ?string $refund): void
    {
        $refundLabel = $refund !== null && bccomp($refund, '0', 2) > 0 ? $this->money($refund) : '';
        $this->patientNotifier->appointment(
            $appointment,
            'Consultation not confirmed',
            "Your doctor didn't confirm this consultation in time, so it was cancelled" . ($refundLabel !== '' ? ' and ' . $refundLabel . ' refunded to your wallet.' : '.'),
            '/dashboard/history/' . $appointment->getId(),
        );
        $this->staffNotifier->notifyDoctor(
            $appointment->getSpecialist()->getId(),
            'appointment',
            'Request expired',
            self::doctorNotConfirmedText(
                self::patientName($appointment, 'a patient'),
                FollowUpService::whenLabel($appointment->getScheduledAt()),
                $refundLabel !== '',
            ),
            '/appointments/' . $appointment->getId(),
        );
        $this->emailPatient($appointment, 'not_confirmed', null, $refundLabel);
    }

    /**
     * The doctor's "request expired" notice. The refund clause only when
     * money actually went back (`$refunded`) — never for an unpaid (settled
     * separately) or free booking.
     */
    public static function doctorNotConfirmedText(string $patient, string $when, bool $refunded): string
    {
        return sprintf(
            "You didn't confirm %s's consultation for %s before it ended, so it was cancelled%s",
            $patient,
            $when,
            $refunded ? ' and the patient refunded.' : '.',
        );
    }

    /**
     * The doctor's "consultation missed" notice for who didn't come
     * (`$party`); the refund clause only when money actually went back.
     */
    public static function doctorMissedText(string $party, string $patient, string $when, bool $refunded): string
    {
        return match ($party) {
            'doctor'  => sprintf(
                "%s was there for the consultation on %s, but you didn't join. It was marked as missed%s",
                $patient,
                $when,
                $refunded ? ' and the patient refunded in full.' : '.',
            ),
            'patient' => sprintf("%s didn't join the consultation on %s. It was marked as missed.", $patient, $when),
            default   => sprintf('Neither you nor %s joined the consultation on %s. It was marked as missed.', $patient, $when),
        };
    }

    /**
     * Tell both sides a consultation was marked missed (`$party` didn't come;
     * `$refund` went back to the wallet) and, for a doctor no-show, alert
     * staff once the doctor reaches the threshold. True when staff were
     * alerted. Also used by the back office marking one missed.
     */
    public function announceMissed(Appointment $appointment, string $party, string $refund, ?DateTimeImmutable $now = null): bool
    {
        $this->notifyMissed($appointment, $party, $refund);

        return $party === 'doctor' && $this->alertRepeatedNoShows($appointment, $now ?? new DateTimeImmutable());
    }

    private function notifyMissed(Appointment $appointment, string $party, string $refund): void
    {
        $refundLabel = bccomp($refund, '0', 2) > 0 ? $this->money($refund) : '';
        $refunded    = $refundLabel !== '' ? ' ' . $refundLabel . ' was refunded to your wallet.' : '';
        [$title, $detail] = match ($party) {
            'doctor'  => ["Your doctor couldn't attend", "Your doctor wasn't able to attend this consultation. We're sorry." . $refunded],
            'patient' => ['Consultation missed', "We didn't see you at this consultation, so it was marked as missed." . $refunded],
            default   => ["Consultation didn't take place", "This consultation didn't take place, so it was marked as missed." . $refunded],
        };
        $this->patientNotifier->appointment($appointment, $title, $detail, '/dashboard/history/' . $appointment->getId());

        $this->staffNotifier->notifyDoctor(
            $appointment->getSpecialist()->getId(),
            'appointment',
            'Consultation missed',
            self::doctorMissedText(
                $party,
                self::patientName($appointment, 'The patient'),
                FollowUpService::whenLabel($appointment->getScheduledAt()),
                $refundLabel !== '',
            ),
            '/appointments/' . $appointment->getId(),
        );
        $this->emailPatient($appointment, 'missed', $party, $refundLabel);
    }

    private function emailPatient(Appointment $appointment, string $why, ?string $noShow, string $refundLabel): void
    {
        $patient = $appointment->getPatient();
        $p       = $patient->toArray();
        $webUrl  = WebUrls::forPatient($patient);
        $doctor  = $appointment->getSpecialist()->getName();
        $when    = FollowUpService::whenLabel($appointment->getScheduledAt());
        $id      = $appointment->getId();
        AfterResponse::defer(function () use ($p, $webUrl, $doctor, $when, $why, $noShow, $refundLabel, $id): void {
            try {
                $mail = EmailTemplates::appointmentClosedUnheld(
                    (string) ($p['first_name'] ?? ''),
                    $doctor,
                    $when,
                    $why,
                    $noShow,
                    $refundLabel,
                    $webUrl . '/dashboard/history/' . rawurlencode($id),
                );
                $this->mail->send(
                    (string) ($p['email'] ?? ''),
                    trim((string) ($p['first_name'] ?? '') . ' ' . (string) ($p['last_name'] ?? '')),
                    $mail['subject'],
                    $mail['html'],
                );
            } catch (\Throwable) {
                // logged inside MailService; the visit is already closed.
            }
        });
    }

    /** "₦10,000.00". */
    private function money(string $amount): string
    {
        $currency = $this->pricing->currency() === 'NGN' ? '₦' : $this->pricing->currency();

        return $currency . number_format((float) $amount, 2);
    }

    private static function patientName(Appointment $appointment, string $fallback): string
    {
        $p    = $appointment->getPatient()->toArray();
        $name = trim(((string) ($p['first_name'] ?? '')) . ' ' . ((string) ($p['last_name'] ?? '')));

        return $name !== '' ? $name : $fallback;
    }
}
