<?php

declare(strict_types=1);

namespace App\Infrastructure\Service;

use App\Domain\Entity\Appointment;
use App\Domain\Entity\ClinicalNote;
use App\Domain\Entity\LabOrder;
use App\Domain\Entity\MedicalCertificate;
use App\Domain\Entity\Prescription;
use App\Domain\Entity\Referral;
use App\Domain\Entity\SessionMetric;
use App\Domain\Entity\TranscriptSegment;
use App\Domain\Enum\AppointmentStatus;
use App\Domain\Settings\WebUrls;
use App\Infrastructure\Email\EmailTemplates;
use App\Infrastructure\Email\MailService;
use DateTimeImmutable;
use Doctrine\ORM\EntityManagerInterface;
use Doctrine\ORM\Query;

/**
 * Closes a consultation: CONFIRMED → COMPLETED, so it moves to both parties'
 * history, can be reviewed and counts towards the doctor's earnings. Used by
 * the doctor's End / "Mark completed" (POST /api/doctor/appointments/{id}/complete)
 * and by the reminders cron, which closes visits a doctor forgot to end once
 * there is proof they took place.
 *
 * The move is a compare-and-set (`UPDATE … WHERE status = 'confirmed'`), so a
 * double-click, a second tab or the cron racing the doctor completes a visit
 * once — and only that one call writes the audit event and tells the patient.
 */
final class ConsultationCompleter
{
    /** How long after a visit's slot has ended the cron waits for the doctor to end it. */
    public const AUTO_COMPLETE_AFTER_HOURS = 12;
    /** Older backlog is closed quietly (still audited) — no "completed" message weeks later. */
    public const NOTIFY_WITHIN_DAYS = 3;
    /** Visits closed per cron run (every candidate has evidence, so the next run takes the rest). */
    private const BATCH = 200;
    /** The shortest slot a doctor can set ({@see \App\Domain\Entity\Specialist::setSlotMinutes()}). */
    private const MIN_SLOT_MINUTES = 15;
    /** How close a doctor's and a patient's call samples must be to count as "on the call together". */
    private const OVERLAP_SECONDS = 60;

    /**
     * Proof a consultation took place, per kind — always something only the
     * doctor can produce: what they wrote for it, their words on the transcript
     * (a patient's captions alone prove nothing — they may have waited in vain),
     * or both sides on the call at the same time (each call screen posts a
     * quality sample every 15 s, so a doctor's sample with a patient's one
     * within OVERLAP_SECONDS means they were connected together — samples
     * minutes apart only mean each was there at some point).
     * Each entry is [entity, alias, extra condition]. Values are bound
     * parameters (EVIDENCE_PARAMS) — a DQL string literal would need a live
     * connection to quote (DATE_SUB/DATE_ADD only read their unit, never quote it).
     */
    private const EVIDENCE = [
        'clinical_note' => [ClinicalNote::class, 'ev_n', '(ev_n.status = :ev_finalized OR ev_n.subjective IS NOT NULL OR ev_n.objective IS NOT NULL OR ev_n.assessment IS NOT NULL OR ev_n.plan IS NOT NULL)'],
        'prescription'  => [Prescription::class, 'ev_p', null],
        'certificate'   => [MedicalCertificate::class, 'ev_c', null],
        'referral'      => [Referral::class, 'ev_r', null],
        'lab_order'     => [LabOrder::class, 'ev_l', null],
        'transcript'    => [TranscriptSegment::class, 'ev_t', 'ev_t.role = :ev_doctor'],
        'session'       => [SessionMetric::class, 'ev_md', 'ev_md.role = :ev_doctor AND EXISTS (SELECT ev_mp.appointmentId FROM '
            . SessionMetric::class . ' ev_mp WHERE ev_mp.appointmentId = ev_md.appointmentId AND ev_mp.role = :ev_patient'
            . ' AND ev_mp.createdAt BETWEEN DATE_SUB(ev_md.createdAt, ' . self::OVERLAP_SECONDS . ", 'second')"
            . ' AND DATE_ADD(ev_md.createdAt, ' . self::OVERLAP_SECONDS . ", 'second'))"],
    ];
    private const EVIDENCE_PARAMS = [
        'ev_finalized' => ClinicalNote::STATUS_FINALIZED,
        'ev_doctor'    => 'doctor',
        'ev_patient'   => 'patient',
    ];

    public function __construct(
        private readonly EntityManagerInterface $em,
        private readonly AuditLogger $audit,
        private readonly PatientNotifier $patientNotifier,
        private readonly MailService $mail,
    ) {
    }

    /**
     * Why the doctor can't mark this consultation completed now, or null when
     * they can. An already-completed visit is answered by the caller first (as
     * an idempotent success). Only a confirmed visit can be completed, and only
     * once it has started — its time has come, or the doctor is in the call
     * (`$doctorInCall` is only asked before the start).
     *
     * @param callable(): bool $doctorInCall
     */
    public static function completionProblem(
        AppointmentStatus $status,
        DateTimeImmutable $scheduledAt,
        callable $doctorInCall,
        ?DateTimeImmutable $now = null,
    ): ?string {
        if (!$status->canTransitionTo(AppointmentStatus::COMPLETED)) {
            return match ($status) {
                AppointmentStatus::COMPLETED => 'This consultation is already completed',
                AppointmentStatus::CANCELLED => "This appointment was cancelled, so it can't be marked completed",
                AppointmentStatus::PROPOSED  => "The patient hasn't accepted this follow-up yet, so it can't be marked completed",
                AppointmentStatus::MISSED    => 'This consultation was marked missed. If it took place, ask the back office to mark it held',
                default                      => 'Confirm this appointment before marking the consultation completed',
            };
        }
        $now ??= new DateTimeImmutable();
        if ($now < $scheduledAt && !$doctorInCall()) {
            return "This consultation hasn't started yet";
        }

        return null;
    }

    /**
     * Is a confirmed visit due for the cron to close: its slot ended more than
     * AUTO_COMPLETE_AFTER_HOURS ago?
     */
    public static function isOverdue(DateTimeImmutable $scheduledAt, int $slotMinutes, ?DateTimeImmutable $now = null, ?int $afterHours = null): bool
    {
        $now ??= new DateTimeImmutable();
        $minutes = max(self::MIN_SLOT_MINUTES, $slotMinutes) + ($afterHours ?? self::AUTO_COMPLETE_AFTER_HOURS) * 60;

        return $scheduledAt->modify('+' . $minutes . ' minutes') <= $now;
    }

    /**
     * Mark a confirmed consultation completed, audit it and tell the patient.
     * Returns false (and records and sends nothing) when it was no longer
     * confirmed — someone else completed or cancelled it first. Either way
     * `$appointment` holds the stored status afterwards.
     *
     * `$from`: the statuses it may be completed from — confirmed for the
     * doctor; the cron and the back office may also complete a visit that took
     * place unconfirmed (pending / rescheduled) or a missed one that was held
     * after all ({@see AppointmentStatus::privilegedTransitions()}).
     * `$closureReason` is stored with it (auto_completed, staff_completed), and
     * `$extra` runs inside the same transaction once it is claimed (e.g. the
     * back office clearing a no-show) — it must not throw.
     *
     * The status change and its audit event commit together: if the audit
     * insert fails, the visit stays confirmed and a retry (or the next cron
     * run) completes it properly — never COMPLETED with no trail and no notice.
     * The patient is told only once that has committed.
     *
     * @param array<string,mixed> $metadata
     */
    public function complete(
        Appointment $appointment,
        string $actorName,
        string $actorRole,
        string $auditAction,
        bool $notifyPatient = true,
        array $metadata = [],
        array $from = [AppointmentStatus::CONFIRMED],
        ?string $closureReason = null,
        ?callable $extra = null,
        ?string $actorId = null,
    ): bool {
        $claimed = $this->em->wrapInTransaction(function () use ($appointment, $actorName, $actorRole, $auditAction, $metadata, $from, $closureReason, $extra, $actorId): bool {
            $claimed = (int) $this->claimQuery($appointment->getId(), $from, $closureReason)->execute() === 1;
            // The UPDATE bypassed the unit of work — load the stored state back.
            $this->em->refresh($appointment);
            if ($claimed) {
                if ($extra !== null) {
                    $extra($appointment);
                    $this->em->flush();
                }
                $this->audit->record(
                    $actorName,
                    $actorRole,
                    $auditAction,
                    $appointment->getId(),
                    'appointment',
                    $appointment->getId(),
                    $metadata,
                    $actorId,
                );
            }

            return $claimed;
        });
        if (!$claimed) {
            return false;
        }

        if ($notifyPatient) {
            $this->notifyPatient($appointment);
        }

        return true;
    }

    /**
     * The reminders cron's pass: close visits whose slot ended more than
     * `$afterHours` (default AUTO_COMPLETE_AFTER_HOURS; the booking setting
     * missed_after_hours via {@see PastAppointmentCloser}) ago AND that have
     * proof they took place (see EVIDENCE) — confirmed ones, and with
     * `$statuses` also ones that took place unconfirmed (pending /
     * rescheduled: audited `appointment.auto_completed_unconfirmed`). Visits
     * without proof are left alone here (the closer marks them missed or
     * expired). Idempotent: a completed visit is no longer a candidate.
     *
     * `$skipIds` are left out (visits that failed in an earlier attempt of this
     * run — see {@see PastAppointmentCloser::runWithRetries()}); the ids that
     * fail now are returned in `failed_ids`.
     *
     * @param list<AppointmentStatus> $statuses
     * @param list<string>            $skipIds
     * @return array{completed: int, quiet: int, kinds: array<string,int>, errors: int, failed_ids: list<string>}
     */
    public function autoCompleteOverdue(?DateTimeImmutable $now = null, ?int $afterHours = null, array $statuses = [AppointmentStatus::CONFIRMED], array $skipIds = []): array
    {
        $now ??= new DateTimeImmutable();
        $afterHours ??= self::AUTO_COMPLETE_AFTER_HOURS;
        $cutoff   = $now->modify('-' . ($afterHours * 60 + self::MIN_SLOT_MINUTES) . ' minutes');
        $notifyOn = $now->modify('-' . self::NOTIFY_WITHIN_DAYS . ' days');

        /** @var list<Appointment> $candidates */
        $candidates = $this->overdueQuery($cutoff, $statuses, $skipIds)->getResult();
        $due = array_values(array_filter(
            $candidates,
            static fn (Appointment $a): bool => self::isOverdue($a->getScheduledAt(), $a->getSpecialist()->getSlotMinutes(), $now, $afterHours),
        ));
        if ($due === []) {
            return ['completed' => 0, 'quiet' => 0, 'kinds' => [], 'errors' => 0, 'failed_ids' => []];
        }

        $kinds     = $this->evidenceKinds(array_map(static fn (Appointment $a): string => $a->getId(), $due));
        $completed = 0;
        $errors    = 0;
        $failed    = [];
        $quiet     = 0;
        $tally     = [];
        foreach ($due as $appointment) {
            $found = $kinds[$appointment->getId()] ?? [];
            if ($found === []) {
                continue; // its proof went away between the two reads — never close without it
            }
            $notify      = $appointment->getScheduledAt() >= $notifyOn;
            $unconfirmed = $appointment->getStatus() !== AppointmentStatus::CONFIRMED;
            try {
                $closed = $this->complete(
                    $appointment,
                    'System',
                    'system',
                    $unconfirmed ? 'appointment.auto_completed_unconfirmed' : 'appointment.auto_completed',
                    $notify,
                    ['evidence' => $found] + ($unconfirmed ? ['was' => $appointment->getStatus()->value] : []),
                    $statuses,
                    'auto_completed',
                );
            } catch (\Throwable $e) {
                // One bad row never stops the rest of the batch — unless it
                // closed the entity manager; then the cron retries on a fresh
                // one, skipping it (`failed_ids`).
                ++$errors;
                $failed[] = $appointment->getId();
                error_log('[auto-complete] completing ' . $appointment->getId() . ' failed: ' . $e::class . ': ' . $e->getMessage());
                if (!$this->em->isOpen()) {
                    break;
                }
                continue;
            }
            if ($closed) {
                ++$completed;
                if (!$notify) {
                    ++$quiet;
                }
                foreach ($found as $kind) {
                    $tally[$kind] = ($tally[$kind] ?? 0) + 1;
                }
            }
        }
        ksort($tally);

        return ['completed' => $completed, 'quiet' => $quiet, 'kinds' => $tally, 'errors' => $errors, 'failed_ids' => $failed];
    }

    /**
     * The compare-and-set behind {@see complete()}: affects one row only while
     * still in one of `$from` (confirmed by default). Records when it closed,
     * and why when `$closureReason` is given.
     *
     * @param list<AppointmentStatus> $from
     */
    public function claimQuery(string $appointmentId, array $from = [AppointmentStatus::CONFIRMED], ?string $closureReason = null): Query
    {
        $qb = $this->em->createQueryBuilder()
            ->update(Appointment::class, 'a')
            ->set('a.status', ':completed')
            ->set('a.updatedAt', ':now')
            ->set('a.closedAt', ':now')
            ->where('a.id = :id')
            ->setParameter('completed', AppointmentStatus::COMPLETED->value)
            ->setParameter('now', new DateTimeImmutable())
            ->setParameter('id', $appointmentId);
        if (count($from) === 1) {
            $qb->andWhere('a.status = :confirmed')->setParameter('confirmed', $from[0]->value);
        } else {
            $qb->andWhere('a.status IN (:confirmed)')
                ->setParameter('confirmed', array_map(static fn (AppointmentStatus $s): string => $s->value, $from));
        }
        if ($closureReason !== null) {
            $qb->set('a.closureReason', ':reason')->setParameter('reason', $closureReason);
        }

        return $qb->getQuery();
    }

    /**
     * Confirmed, not deleted, starting before `$cutoff`, with evidence — oldest
     * first. Candidates without evidence are never selected, so a backlog of
     * no-shows can't crowd the batch out. Each kind is a correlated EXISTS on
     * that table's appointment_id index, so a run probes only the candidates'
     * own rows instead of reading whole tables (an uncorrelated `IN (SELECT …)`
     * under OR can't become a semi-join and would hash every call sample).
     */
    /**
     * "(EXISTS (…) OR EXISTS (…) …)" — the appointment aliased `$appointment`
     * has proof it took place (any EVIDENCE kind), correlated per row. Bind
     * its parameters with {@see bindEvidence()}. Used here and by the closer
     * (NOT …: the visits with no proof).
     */
    public function evidenceExistsDql(string $appointment = 'a'): string
    {
        $proof = [];
        foreach (self::EVIDENCE as [$entity, $alias, $condition]) {
            $proof[] = 'EXISTS (' . $this->evidenceDql($entity, $alias, "$alias.appointmentId = $appointment.id", $condition) . ')';
        }

        return '(' . implode(' OR ', $proof) . ')';
    }

    /**
     * @param list<AppointmentStatus> $statuses
     * @param list<string>            $skipIds left out (failed earlier in this run)
     */
    public function overdueQuery(DateTimeImmutable $cutoff, array $statuses = [AppointmentStatus::CONFIRMED], array $skipIds = []): Query
    {
        $proof = [];
        foreach (self::EVIDENCE as [$entity, $alias, $condition]) {
            $proof[] = 'EXISTS (' . $this->evidenceDql($entity, $alias, "$alias.appointmentId = a.id", $condition) . ')';
        }

        $qb = $this->em->createQueryBuilder()
            ->select('a', 's')
            ->from(Appointment::class, 'a')
            ->join('a.specialist', 's')
            ->andWhere(count($statuses) === 1 ? 'a.status = :confirmed' : 'a.status IN (:confirmed)')
            ->andWhere('a.deletedAt IS NULL')
            ->andWhere('a.scheduledAt < :cutoff')
            ->andWhere(implode(' OR ', $proof))
            ->setParameter('confirmed', count($statuses) === 1
                ? $statuses[0]->value
                : array_map(static fn (AppointmentStatus $s): string => $s->value, $statuses))
            ->setParameter('cutoff', $cutoff);
        self::excludeIds($qb, $skipIds);

        $query = $qb->orderBy('a.scheduledAt', 'ASC')
            ->setMaxResults(self::BATCH)
            ->getQuery();

        return $this->bindEvidence($query);
    }

    /**
     * Leave `$ids` out of a query on appointments aliased `a` (no-op when empty).
     *
     * @param list<string> $ids
     */
    public static function excludeIds(\Doctrine\ORM\QueryBuilder $qb, array $ids): \Doctrine\ORM\QueryBuilder
    {
        if ($ids !== []) {
            $qb->andWhere('a.id NOT IN (:skip)')->setParameter('skip', array_values(array_unique($ids)));
        }

        return $qb;
    }

    /**
     * Per evidence kind, which of these appointments have it.
     *
     * @param list<string> $ids
     * @return array<string, Query>
     */
    public function evidenceQueries(array $ids): array
    {
        $queries = [];
        foreach (self::EVIDENCE as $kind => [$entity, $alias, $condition]) {
            $queries[$kind] = $this->bindEvidence($this->em
                ->createQuery($this->evidenceDql($entity, $alias, "$alias.appointmentId IN (:ids)", $condition, true))
                ->setParameter('ids', $ids));
        }

        return $queries;
    }

    /**
     * Which evidence kinds each appointment has (for the audit trail, and the
     * closer re-checking a visit before it marks it missed).
     *
     * @param list<string> $ids
     * @return array<string, list<string>>
     */
    public function evidenceKinds(array $ids): array
    {
        if ($ids === []) {
            return [];
        }
        $out = [];
        foreach ($this->evidenceQueries($ids) as $kind => $query) {
            $rows = $query->getScalarResult();
            foreach (array_unique(array_map(static fn (array $r): string => (string) reset($r), $rows)) as $id) {
                $out[$id][] = $kind;
            }
        }

        return $out;
    }

    /** "SELECT alias.appointmentId FROM Entity alias WHERE <which appointments> AND …" — rows of this kind of evidence. */
    private function evidenceDql(string $entity, string $alias, string $appointments, ?string $condition, bool $distinct = false): string
    {
        return 'SELECT ' . ($distinct ? 'DISTINCT ' : '') . "$alias.appointmentId FROM $entity $alias WHERE $appointments"
            . ($condition !== null ? " AND $condition" : '');
    }

    /** Bind the EVIDENCE_PARAMS this query uses (Doctrine refuses unused ones). */
    public function bindEvidence(Query $query): Query
    {
        foreach (self::EVIDENCE_PARAMS as $name => $value) {
            if (str_contains($query->getDQL() ?? '', ':' . $name)) {
                $query->setParameter($name, $value);
            }
        }

        return $query;
    }

    /**
     * In-app notification (opens the visit in their history) + email. Generic on
     * purpose: never the reason for the visit, a diagnosis or a medicine.
     */
    private function notifyPatient(Appointment $appointment): void
    {
        $this->patientNotifier->appointment(
            $appointment,
            'Consultation completed',
            'Your consultation is complete. Anything your doctor shares will appear in your consultation history.',
            '/dashboard/history/' . $appointment->getId(),
        );

        $appt    = $appointment->toArray();
        $patient = $appointment->getPatient();
        $p       = $patient->toArray();
        $webUrl  = WebUrls::forPatient($patient);
        // After the reply: the doctor's End waits on this request.
        AfterResponse::defer(function () use ($appt, $p, $webUrl): void {
            try {
                $mail = EmailTemplates::consultationCompleted($appt, (string) ($p['first_name'] ?? ''), $webUrl);
                $this->mail->send(
                    (string) ($p['email'] ?? ''),
                    trim((string) ($p['first_name'] ?? '') . ' ' . (string) ($p['last_name'] ?? '')),
                    $mail['subject'],
                    $mail['html'],
                );
            } catch (\Throwable) {
                // logged inside MailService; the consultation is already completed.
            }
        });
    }
}
