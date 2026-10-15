<?php

declare(strict_types=1);

namespace App\Infrastructure\Service;

use App\Domain\Doctor\DoctorCredentials;
use App\Domain\Entity\Appointment;
use App\Domain\Entity\Specialist;
use App\Domain\Entity\SpecialistStatusEvent;
use App\Domain\Enum\AppointmentStatus;
use App\Domain\Enum\NotificationType;
use App\Domain\Enum\SpecialistStatus;
use App\Domain\Exception\ValidationException;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\SpecialistCredentialRepository;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\SpecialistStatusEventRepository;
use App\Domain\Repository\UserRepository;
use App\Domain\Settings\ClinicTime;
use App\Domain\Settings\WebUrls;
use App\Infrastructure\Email\EmailTemplates;
use App\Infrastructure\Email\MailService;
use DateTimeImmutable;

/**
 * Suspension = the doctor stopped practising here (a short break is the
 * doctor's own `available` switch instead). Suspending a doctor:
 *
 *  1. records the status (and a status event) — they are unlisted at once and
 *     every clinical route refuses them ({@see \App\Domain\Doctor\DoctorStanding});
 *  2. signs them out everywhere (they may sign back in to see why, their
 *     earnings and payouts), and puts the decision on the audit trail;
 *  3. cancels every future pending / confirmed / rescheduled booking — and one
 *     in progress (started, its slot not over) with no proof the consultation
 *     is taking place ({@see ConsultationCompleter} evidence; one with proof is
 *     left to finish and reported as `in_progress`) — and refunds it to the
 *     patient's wallet through AppointmentPaymentService (guest fees included
 *     — they are part of the booking's amount), one database transaction per
 *     batch, each booking re-read under its row lock;
 *  4. withdraws their open follow-up proposals (nothing was paid);
 *  5. tells each patient: the in-app notice is saved with the cancellation;
 *     the email (the refund and a link to doctors of the same specialty) and
 *     each guest's notice go after the response.
 *
 * Running it again for a suspended doctor is safe: the status is left alone
 * and only bookings still live are cancelled (refunds are idempotent on the
 * appointment). {@see preview()} counts the same without changing anything.
 * Reinstating needs a verified, unexpired practising licence and a note, and
 * restores no booking.
 */
final class SpecialistSuspensionService
{
    /** code => label */
    public const CODES = [
        'licence_expired' => 'Practising licence expired',
        'conduct'         => 'Professional conduct concern',
        'complaint'       => 'Complaint under review',
        'admin'           => 'Administrative',
        'other'           => 'Other',
    ];

    /** Bookings cancelled per database transaction. */
    private const BATCH = 25;

    /** How far {@see upcoming()} reads (a doctor never has more future bookings than this). */
    private const MAX_BOOKINGS = 5000;

    private const PAGE = 100;

    public function __construct(
        private readonly SpecialistRepository $specialists,
        private readonly AppointmentRepository $appointments,
        private readonly AppointmentPaymentService $payments,
        private readonly FollowUpService $followUps,
        private readonly GuestInvitations $guests,
        private readonly PatientNotifier $patientNotifier,
        private readonly StaffNotifier $staffNotifier,
        private readonly MailService $mail,
        private readonly PricingService $pricing,
        private readonly AuditLogger $audit,
        private readonly SpecialistStatusEventRepository $statusEvents,
        private readonly SpecialistCredentialRepository $credentials,
        private readonly SessionService $sessions,
        private readonly UserRepository $users,
        private readonly ConsultationCompleter $completer,
    ) {
    }

    public static function codeLabel(string $code): string
    {
        return self::CODES[$code] ?? ucfirst(str_replace('_', ' ', $code));
    }

    // ----- Rules (pure) -----

    /**
     * Why this doctor can't be suspended with this code and reason, as
     * field => message. A doctor already suspended can be (re-run).
     *
     * @return array<string,string>
     */
    public static function suspendProblems(Specialist $s, string $code, string $reason): array
    {
        $problems = [];
        $status   = $s->getStatus();
        if ($status !== SpecialistStatus::APPROVED && $status !== SpecialistStatus::SUSPENDED) {
            $problems['status'] = 'Only an approved doctor can be suspended. Send a profile in review back instead.';
        }
        if (!array_key_exists($code, self::CODES)) {
            $problems['code'] = 'Choose a reason: ' . implode(', ', array_keys(self::CODES));
        }
        $reason = trim($reason);
        if ($reason === '') {
            $problems['reason'] = 'Explain why — the doctor will see this';
        } elseif (mb_strlen($reason) > DoctorOnboardingService::MAX_REASON) {
            $problems['reason'] = 'Keep the reason under 2000 characters';
        }

        return $problems;
    }

    /**
     * Why this doctor can't be reinstated now: they must be suspended, a
     * reviewer must explain why (`$note`), and a practising licence must be
     * verified and unexpired.
     *
     * @param list<\App\Domain\Entity\SpecialistCredential> $credentials
     * @return array<string,string>
     */
    public static function reinstateProblems(Specialist $s, string $note, array $credentials, string $todayYmd): array
    {
        if (!$s->isSuspended()) {
            return ['status' => 'This doctor is not suspended'];
        }
        $problems = [];
        $note     = trim($note);
        if ($note === '') {
            $problems['note'] = 'Add a note saying why the suspension is lifted';
        } elseif (mb_strlen($note) > DoctorOnboardingService::MAX_REASON) {
            $problems['note'] = 'Keep the note under 2000 characters';
        }
        if (DoctorCredentials::currentLicence($credentials, $todayYmd) === null) {
            $problems['practising_licence'] = 'Verify a current annual practising licence before reinstating';
        }

        return $problems;
    }

    /**
     * A booking that started at or before this moment is over (its slot of
     * `$slotMinutes` has ended); 0 = any that started.
     */
    public static function endedBefore(DateTimeImmutable $now, int $slotMinutes): DateTimeImmutable
    {
        return $slotMinutes > 0 ? $now->modify('-' . $slotMinutes . ' minutes') : $now;
    }

    /**
     * What suspending would do to these appointments (the doctor's, read by
     * {@see upcoming()}): the bookings to cancel — future ones, and ones in
     * progress (started less than `$slotMinutes` ago) without proof the
     * consultation is taking place (`$evidenced`: the ids with proof, which
     * are left to finish and returned as `in_progress`) — the proposals to
     * withdraw, how many patients are affected, and what goes back to wallets.
     *
     * @param list<Appointment> $appointments
     * @param list<string>      $evidenced
     * @return array{bookings: list<Appointment>, proposals: list<Appointment>, in_progress: list<Appointment>, patients: int, refunds: int, refund_total: string, guests: int, guest_fees: string}
     */
    public static function plan(array $appointments, DateTimeImmutable $now, int $slotMinutes = 0, array $evidenced = []): array
    {
        $live       = [AppointmentStatus::PENDING, AppointmentStatus::CONFIRMED, AppointmentStatus::RESCHEDULED];
        $ended      = self::endedBefore($now, $slotMinutes);
        $bookings   = [];
        $proposals  = [];
        $inProgress = [];
        $patients   = [];
        $refunds    = 0;
        $total      = '0.00';
        $guests     = 0;
        $guestFees  = '0.00';
        foreach ($appointments as $a) {
            $at = $a->getScheduledAt();
            if ($a->getStatus() === AppointmentStatus::PROPOSED) {
                // One whose time came unanswered is the follow-up cron's to expire.
                if ($at > $now) {
                    $proposals[]                         = $a;
                    $patients[$a->getPatient()->getId()] = true;
                }
                continue;
            }
            if ($at <= $ended || !in_array($a->getStatus(), $live, true)) {
                continue;
            }
            if ($at <= $now && in_array($a->getId(), $evidenced, true)) {
                // Taking place: left to finish (the cron completes it on its evidence).
                $inProgress[] = $a;
                continue;
            }
            $bookings[]                            = $a;
            $patients[$a->getPatient()->getId()] = true;
            $guests += count($a->getGuests());
            if ($a->getPaymentStatus() === 'paid' && !$a->isFree()) {
                $refunds++;
                $total = bcadd($total, $a->getAmount(), 2);
                foreach ($a->getGuests() as $guest) {
                    $guestFees = bcadd($guestFees, bcadd((string) ($guest['fee'] ?? '0'), '0', 2), 2);
                }
            }
        }

        return [
            'bookings'     => $bookings,
            'proposals'    => $proposals,
            'in_progress'  => $inProgress,
            'patients'     => count($patients),
            'refunds'      => $refunds,
            'refund_total' => $total,
            'guests'       => $guests,
            'guest_fees'   => $guestFees,
        ];
    }

    /**
     * Cancel one booking of a doctor who stopped practising and refund it
     * (call inside a transaction, after locking it). One whose slot is over
     * (`$slotMinutes` after it started; 0 = once it started), or that is no
     * longer live (cancelled or completed meanwhile, a re-run), is left alone.
     * Whether one in progress may go is {@see plan()}'s call.
     *
     * @return array{cancelled: bool, refunded: ?string}
     */
    public function cancelBooking(Appointment $appointment, DateTimeImmutable $now, int $slotMinutes = 0): array
    {
        $live = [AppointmentStatus::PENDING, AppointmentStatus::CONFIRMED, AppointmentStatus::RESCHEDULED];
        if ($appointment->getScheduledAt() <= self::endedBefore($now, $slotMinutes) || !in_array($appointment->getStatus(), $live, true)) {
            return ['cancelled' => false, 'refunded' => null];
        }
        $appointment->transitionTo(AppointmentStatus::CANCELLED);
        $refund = $this->payments->refundForCancellation($appointment);

        return ['cancelled' => true, 'refunded' => $refund?->getAmount()];
    }

    // ----- Effects -----

    /**
     * The doctor's appointments suspension would touch (live bookings and open
     * proposals whose slot is not over yet), read in full before anything changes.
     *
     * @return list<Appointment>
     */
    public function upcoming(Specialist $s, DateTimeImmutable $now): array
    {
        $statuses = [AppointmentStatus::PENDING, AppointmentStatus::CONFIRMED, AppointmentStatus::RESCHEDULED, AppointmentStatus::PROPOSED];
        $ended    = self::endedBefore($now, $s->getSlotMinutes());
        $out      = [];
        for ($offset = 0; $offset < self::MAX_BOOKINGS; $offset += self::PAGE) {
            // Newest first: stop at the first one that is already over.
            $page = $this->appointments->paginatedForSpecialist($offset, self::PAGE, $s->getId(), $statuses);
            foreach ($page['items'] as $appointment) {
                if ($appointment->getScheduledAt() <= $ended) {
                    return $out;
                }
                $out[] = $appointment;
            }
            if (count($page['items']) < self::PAGE) {
                break;
            }
        }

        return $out;
    }

    /**
     * What suspending would do now — for the confirm dialog. Changes nothing.
     *
     * @return array<string,mixed>
     */
    public function preview(Specialist $s, ?DateTimeImmutable $now = null): array
    {
        $now    ??= new DateTimeImmutable();
        $upcoming = $this->upcoming($s, $now);
        $plan     = self::plan($upcoming, $now, $s->getSlotMinutes(), $this->evidenced($upcoming, $now));

        return [
            'already_suspended' => $s->isSuspended(),
            'bookings'          => count($plan['bookings']),
            'proposals'         => count($plan['proposals']),
            'in_progress'       => count($plan['in_progress']),
            'patients'          => $plan['patients'],
            'refunds'           => $plan['refunds'],
            'refund_total'      => $plan['refund_total'],
            'guests'            => $plan['guests'],
            'guest_fees'        => $plan['guest_fees'],
            'currency'          => $this->pricing->currency(),
        ];
    }

    /**
     * Suspend the doctor (see the class doc). `$actorId` null = the system
     * (an expired licence). Returns what happened; `incomplete` means a batch
     * failed part-way — running it again finishes the job.
     *
     * @return array<string,mixed>
     * @throws ValidationException
     */
    public function suspend(Specialist $s, string $code, string $reason, ?string $actorId, string $actorName, ?DateTimeImmutable $now = null): array
    {
        $problems = self::suspendProblems($s, $code, $reason);
        if ($problems !== []) {
            throw new ValidationException($problems, (string) reset($problems));
        }
        $now   ??= new DateTimeImmutable();
        $reason  = trim($reason);
        $already = $s->isSuspended();

        if (!$already) {
            $from = $s->getStatus()->value;
            $s->suspend($code, $reason, $actorId, $now);
            // Status + its event in one flush: both or neither.
            $this->statusEvents->persist(new SpecialistStatusEvent(
                $s->getId(),
                $from,
                SpecialistStatus::SUSPENDED->value,
                $actorId,
                $actorName,
                $reason,
                $code,
                [],
                $now,
            ));
            $this->specialists->save($s);
        }

        $revoked = 0;
        try {
            $login   = $this->users->findBySpecialist($s->getId());
            $revoked = $login !== null ? $this->sessions->revokeAllStaff($login->getId()) : 0;
        } catch (\Throwable $e) {
            error_log('[suspension] revoking sessions failed: ' . $e->getMessage());
        }

        // The decision goes on record before any booking is touched: a batch
        // failing below closes the entity manager, and nothing more is written.
        $this->record($actorName, $actorId, $already ? 'specialist.suspension_rerun' : 'specialist.suspended', $s, [
            'code'             => $code,
            'reason'           => $reason,
            'sessions_revoked' => $revoked,
        ]);

        $affected = $this->cancelUpcoming($s, $actorName, $now);

        $bookings = array_diff_key($affected, ['currency' => true]);
        if ($this->audit->isWritable()) {
            $this->record($actorName, $actorId, 'specialist.suspension_bookings', $s, ['code' => $code] + $bookings);
        } else {
            error_log('[suspension] ' . $s->getId() . ' bookings (not audited — a batch failed): ' . json_encode($bookings));
        }

        if (!$already) {
            $this->staffNotifier->notifyDoctor($s->getId(), 'onboarding', 'Account suspended', self::codeLabel($code) . ': ' . $reason, '/onboarding');
            $tpl   = EmailTemplates::doctorSuspended($s->getName(), self::codeLabel($code), $reason, WebUrls::forSpecialist($s));
            $email = $this->doctorEmail($s);
            $name  = $s->getName();
            if ($email !== null) {
                AfterResponse::defer(fn () => $this->mail->send($email, $name, $tpl['subject'], $tpl['html']));
            }
        }

        return ['already_suspended' => $already, 'sessions_revoked' => $revoked] + $affected;
    }

    /**
     * Lift a suspension: a verified, unexpired licence and a note are needed.
     * Cancelled bookings stay cancelled.
     *
     * @throws ValidationException
     */
    public function reinstate(Specialist $s, string $note, ?string $actorId, string $actorName): void
    {
        $credentials = $this->credentials->forSpecialist($s->getId());
        $today       = ClinicTime::todayYmd();
        $problems    = self::reinstateProblems($s, $note, $credentials, $today);
        if ($problems !== []) {
            throw new ValidationException($problems, (string) reset($problems));
        }

        $code = $s->getSuspensionCode();
        $s->reinstate();
        $s->setLicenceExpiresAt(DoctorCredentials::currentLicence($credentials, $today)?->getExpiresAt());
        $this->statusEvents->persist(new SpecialistStatusEvent(
            $s->getId(),
            SpecialistStatus::SUSPENDED->value,
            SpecialistStatus::APPROVED->value,
            $actorId,
            $actorName,
            trim($note),
            null,
            ['lifted_code' => $code],
        ));
        $this->specialists->save($s);

        $this->record($actorName, $actorId, 'specialist.reinstated', $s, [
            'note'        => trim($note),
            'lifted_code' => $code,
        ], 'admin');
        $this->staffNotifier->notifyDoctor($s->getId(), 'onboarding', 'Account reinstated', 'Your suspension has been lifted. Patients can book you again.', '/dashboard');
        $tpl   = EmailTemplates::doctorReinstated($s->getName(), WebUrls::forSpecialist($s));
        $email = $this->doctorEmail($s);
        $name  = $s->getName();
        if ($email !== null) {
            AfterResponse::defer(fn () => $this->mail->send($email, $name, $tpl['subject'], $tpl['html']));
        }
    }

    /**
     * Cancel + refund the live bookings in batches (each one's in-app notice
     * saved with it), withdraw open proposals, and queue the emails and
     * guests' notices for after the response.
     *
     * @return array<string,mixed>
     */
    private function cancelUpcoming(Specialist $s, string $actorName, DateTimeImmutable $now): array
    {
        $slot       = $s->getSlotMinutes();
        $upcoming   = $this->upcoming($s, $now);
        $plan       = self::plan($upcoming, $now, $slot, $this->evidenced($upcoming, $now));
        $cancelled  = [];
        $failed     = 0;
        $incomplete = false;

        foreach (array_chunk($plan['bookings'], self::BATCH) as $batch) {
            if ($incomplete) {
                $failed += count($batch);
                continue;
            }
            try {
                $done = $this->appointments->transactional(function () use ($batch, $now, $slot): array {
                    $out = [];
                    foreach ($batch as $appointment) {
                        // Re-read under the row lock: a patient cancelling or the
                        // doctor completing it meanwhile wins, and isn't redone.
                        $this->appointments->lockAndRefresh($appointment);
                        $result = $this->cancelBooking($appointment, $now, $slot);
                        if ($result['cancelled']) {
                            $this->appointments->persist($appointment);
                            // Saved in this transaction: a later batch failing can't lose it.
                            $this->noticePatient($appointment, $result['refunded'], false);
                            $out[] = [$appointment, $result['refunded']];
                        }
                    }

                    return $out;
                });
                array_push($cancelled, ...$done);
            } catch (\Throwable $e) {
                // The batch rolled back (and the entity manager closed): stop
                // here — running the suspension again picks up what is left.
                error_log('[suspension] cancelling a booking batch failed: ' . $e::class . ': ' . $e->getMessage());
                $failed += count($batch);
                $incomplete = true;
            }
        }

        $withdrawn = [];
        foreach ($plan['proposals'] as $proposal) {
            if ($incomplete) {
                break;
            }
            try {
                if ($this->followUps->cancelByStaff($proposal, $actorName)) {
                    $this->noticePatient($proposal, null, true);
                    $withdrawn[] = $proposal;
                }
            } catch (ValidationException) {
                // The patient accepted it a moment ago: it is a booking now, so a re-run cancels it.
                $incomplete = true;
            } catch (\Throwable $e) {
                error_log('[suspension] withdrawing a follow-up failed: ' . $e->getMessage());
                $incomplete = true;
            }
        }

        $refundTotal = '0.00';
        $refunded    = 0;
        $guests      = 0;
        $patients    = [];
        foreach ($cancelled as [$appointment, $refund]) {
            if ($refund !== null) {
                $refunded++;
                $refundTotal = bcadd($refundTotal, $refund, 2);
            }
            $guests += count($appointment->getGuests());
            $patients[$appointment->getPatient()->getId()] = true;
            // One task each, so one failing notice never stops the rest.
            AfterResponse::defer(fn () => $this->emailPatient($appointment, $refund, false));
            AfterResponse::defer(fn () => $this->guests->notifyCancelled($appointment));
        }
        foreach ($withdrawn as $proposal) {
            $patients[$proposal->getPatient()->getId()] = true;
            AfterResponse::defer(fn () => $this->emailPatient($proposal, null, true));
        }

        return [
            'cancelled'           => count($cancelled),
            'refunded_count'      => $refunded,
            'refunded_total'      => $refundTotal,
            'guests_notified'     => $guests,
            'proposals_withdrawn' => count($withdrawn),
            'patients_notified'   => count($patients),
            'in_progress'         => count($plan['in_progress']),
            'failed'              => $failed,
            'incomplete'          => $incomplete,
            'currency'            => $this->pricing->currency(),
        ];
    }

    /**
     * Of these appointments, the ids of those already started with proof the
     * consultation is taking place ({@see ConsultationCompleter::evidenceQueries()}).
     *
     * @param list<Appointment> $appointments
     * @return list<string>
     */
    private function evidenced(array $appointments, DateTimeImmutable $now): array
    {
        $started = [];
        foreach ($appointments as $a) {
            if ($a->getScheduledAt() <= $now && $a->getStatus() !== AppointmentStatus::PROPOSED) {
                $started[] = $a->getId();
            }
        }
        if ($started === []) {
            return [];
        }

        $found = [];
        foreach ($this->completer->evidenceQueries($started) as $query) {
            foreach ($query->getScalarResult() as $row) {
                $found[(string) reset($row)] = true;
            }
        }

        return array_map('strval', array_keys($found));
    }

    /**
     * The patient's in-app notice: the doctor is no longer available, what
     * was refunded, and a link to doctors of the same specialty. Never the
     * reason for the suspension.
     */
    private function noticePatient(Appointment $appointment, ?string $refund, bool $proposal): void
    {
        $doctor   = $appointment->getSpecialist();
        $when     = FollowUpService::whenLabel($appointment->getScheduledAt());
        $refunded = $this->refundLabel($refund);

        $this->patientNotifier->notify(
            $appointment->getPatient(),
            NotificationType::APPOINTMENT,
            $proposal ? 'Follow-up withdrawn' : 'Consultation cancelled',
            $proposal
                ? sprintf('%s is no longer available on VideoMed, so the follow-up proposed for %s was withdrawn. Nothing was charged.', $doctor->getName(), $when)
                : sprintf(
                    '%s is no longer available on VideoMed, so your consultation on %s was cancelled.%s You can book another %s specialist.',
                    $doctor->getName(),
                    $when,
                    $refunded !== '' ? ' ' . $refunded . ' was refunded to your wallet.' : '',
                    $doctor->getSpecialty(),
                ),
            self::rebookPath($appointment),
        );
    }

    /** The patient's email — the same news as {@see noticePatient()}, never the reason. */
    private function emailPatient(Appointment $appointment, ?string $refund, bool $proposal): void
    {
        $patient = $appointment->getPatient();
        $doctor  = $appointment->getSpecialist();
        try {
            $p    = $patient->toArray();
            $mail = EmailTemplates::doctorUnavailableCancellation(
                (string) ($p['first_name'] ?? ''),
                $doctor->getName(),
                $doctor->getSpecialty(),
                FollowUpService::whenLabel($appointment->getScheduledAt()),
                $this->refundLabel($refund),
                WebUrls::forPatient($patient) . self::rebookPath($appointment),
                $proposal,
            );
            $this->mail->send(
                (string) ($p['email'] ?? ''),
                trim((string) ($p['first_name'] ?? '') . ' ' . (string) ($p['last_name'] ?? '')),
                $mail['subject'],
                $mail['html'],
            );
        } catch (\Throwable) {
            // logged inside MailService; the cancellation already stands.
        }
    }

    /** Doctors of the same specialty, in the patient app. */
    private static function rebookPath(Appointment $appointment): string
    {
        return '/dashboard/specialists?specialty=' . rawurlencode($appointment->getSpecialist()->getSpecialty());
    }

    /** "₦10,000.00" for a refund above zero, else ''. */
    private function refundLabel(?string $refund): string
    {
        return $refund !== null && bccomp($refund, '0', 2) > 0 ? $this->money($refund) : '';
    }

    /**
     * Put one suspension step on the audit trail for this doctor (never fatal:
     * the change itself is saved).
     *
     * @param array<string,mixed> $metadata
     */
    private function record(string $actorName, ?string $actorId, string $action, Specialist $s, array $metadata, ?string $role = null): void
    {
        try {
            $this->audit->record(
                $actorName,
                $role ?? ($actorId !== null ? 'admin' : 'system'),
                $action,
                null,
                'specialist',
                $s->getId(),
                ['doctor' => $s->getName()] + $metadata,
                $actorId,
            );
        } catch (\Throwable $e) {
            error_log('[suspension] audit ' . $action . ' failed: ' . $e->getMessage());
        }
    }

    private function doctorEmail(Specialist $s): ?string
    {
        try {
            $email = $this->users->findBySpecialist($s->getId())?->getEmail() ?? $s->getEmail();
        } catch (\Throwable) {
            $email = $s->getEmail();
        }

        return $email !== null && $email !== '' ? $email : null;
    }

    /** "₦10,000.00". */
    private function money(string $amount): string
    {
        $currency = $this->pricing->currency() === 'NGN' ? '₦' : $this->pricing->currency();

        return $currency . number_format((float) $amount, 2);
    }
}
