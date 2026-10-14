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
    public static function isOverdue(DateTimeImmutable $scheduledAt, int $slotMinutes, ?DateTimeImmutable $now = null): bool
    {
        $now ??= new DateTimeImmutable();
        $minutes = max(self::MIN_SLOT_MINUTES, $slotMinutes) + self::AUTO_COMPLETE_AFTER_HOURS * 60;

        return $scheduledAt->modify('+' . $minutes . ' minutes') <= $now;
    }

    /**
     * Mark a confirmed consultation completed, audit it and tell the patient.
     * Returns false (and records and sends nothing) when it was no longer
     * confirmed — someone else completed or cancelled it first. Either way
     * `$appointment` holds the stored status afterwards.
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
    ): bool {
        $claimed = $this->em->wrapInTransaction(function () use ($appointment, $actorName, $actorRole, $auditAction, $metadata): bool {
            $claimed = (int) $this->claimQuery($appointment->getId())->execute() === 1;
            // The UPDATE bypassed the unit of work — load the stored state back.
            $this->em->refresh($appointment);
            if ($claimed) {
                $this->audit->record(
                    $actorName,
                    $actorRole,
                    $auditAction,
                    $appointment->getId(),
                    'appointment',
                    $appointment->getId(),
                    $metadata,
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
     * The reminders cron's pass: close confirmed visits whose slot ended more
     * than AUTO_COMPLETE_AFTER_HOURS ago AND that have proof they took place
     * (see EVIDENCE). Visits without proof (a no-show, a call that never
     * happened) are left for the doctor or the back office. Idempotent: a
     * completed visit is no longer a candidate.
     *
     * @return array{completed: int, quiet: int, kinds: array<string,int>}
     */
    public function autoCompleteOverdue(?DateTimeImmutable $now = null): array
    {
        $now ??= new DateTimeImmutable();
        $cutoff   = $now->modify('-' . (self::AUTO_COMPLETE_AFTER_HOURS * 60 + self::MIN_SLOT_MINUTES) . ' minutes');
        $notifyOn = $now->modify('-' . self::NOTIFY_WITHIN_DAYS . ' days');

        /** @var list<Appointment> $candidates */
        $candidates = $this->overdueQuery($cutoff)->getResult();
        $due = array_values(array_filter(
            $candidates,
            static fn (Appointment $a): bool => self::isOverdue($a->getScheduledAt(), $a->getSpecialist()->getSlotMinutes(), $now),
        ));
        if ($due === []) {
            return ['completed' => 0, 'quiet' => 0, 'kinds' => []];
        }

        $kinds     = $this->evidenceKinds(array_map(static fn (Appointment $a): string => $a->getId(), $due));
        $completed = 0;
        $quiet     = 0;
        $tally     = [];
        foreach ($due as $appointment) {
            $found = $kinds[$appointment->getId()] ?? [];
            if ($found === []) {
                continue; // its proof went away between the two reads — never close without it
            }
            $notify = $appointment->getScheduledAt() >= $notifyOn;
            if ($this->complete($appointment, 'System', 'system', 'appointment.auto_completed', $notify, ['evidence' => $found])) {
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

        return ['completed' => $completed, 'quiet' => $quiet, 'kinds' => $tally];
    }

    /** The compare-and-set behind {@see complete()}: affects one row only while still confirmed. */
    public function claimQuery(string $appointmentId): Query
    {
        return $this->em->createQueryBuilder()
            ->update(Appointment::class, 'a')
            ->set('a.status', ':completed')
            ->set('a.updatedAt', ':now')
            ->where('a.id = :id')
            ->andWhere('a.status = :confirmed')
            ->setParameter('completed', AppointmentStatus::COMPLETED->value)
            ->setParameter('confirmed', AppointmentStatus::CONFIRMED->value)
            ->setParameter('now', new DateTimeImmutable())
            ->setParameter('id', $appointmentId)
            ->getQuery();
    }

    /**
     * Confirmed, not deleted, starting before `$cutoff`, with evidence — oldest
     * first. Candidates without evidence are never selected, so a backlog of
     * no-shows can't crowd the batch out. Each kind is a correlated EXISTS on
     * that table's appointment_id index, so a run probes only the candidates'
     * own rows instead of reading whole tables (an uncorrelated `IN (SELECT …)`
     * under OR can't become a semi-join and would hash every call sample).
     */
    public function overdueQuery(DateTimeImmutable $cutoff): Query
    {
        $proof = [];
        foreach (self::EVIDENCE as [$entity, $alias, $condition]) {
            $proof[] = 'EXISTS (' . $this->evidenceDql($entity, $alias, "$alias.appointmentId = a.id", $condition) . ')';
        }

        $query = $this->em->createQueryBuilder()
            ->select('a', 's')
            ->from(Appointment::class, 'a')
            ->join('a.specialist', 's')
            ->andWhere('a.status = :confirmed')
            ->andWhere('a.deletedAt IS NULL')
            ->andWhere('a.scheduledAt < :cutoff')
            ->andWhere(implode(' OR ', $proof))
            ->setParameter('confirmed', AppointmentStatus::CONFIRMED->value)
            ->setParameter('cutoff', $cutoff)
            ->orderBy('a.scheduledAt', 'ASC')
            ->setMaxResults(self::BATCH)
            ->getQuery();

        return $this->bindEvidence($query);
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
     * Which evidence kinds each appointment has (for the audit trail).
     *
     * @param list<string> $ids
     * @return array<string, list<string>>
     */
    private function evidenceKinds(array $ids): array
    {
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
    private function bindEvidence(Query $query): Query
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
