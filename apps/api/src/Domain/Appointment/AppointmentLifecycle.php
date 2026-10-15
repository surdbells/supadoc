<?php

declare(strict_types=1);

namespace App\Domain\Appointment;

use App\Domain\Entity\Appointment;
use App\Domain\Enum\AppointmentStatus;
use DateTimeImmutable;

/**
 * Where an appointment is in time, and how every app should show it — one
 * mapping, computed on the server, so no client re-derives it from the status.
 * Pure: the entity serialises with it, the lists, the actions and the cron
 * closer ask it.
 *
 * Phase (by TIME, not by status):
 *  - upcoming: still to come — an open booking or proposal that hasn't started;
 *  - live:     started and not yet LIVE_GRACE_MINUTES past its end, or someone
 *              is in the call now (a call that runs over stays live);
 *  - past:     over — its slot ended more than LIVE_GRACE_MINUTES ago (and
 *              nobody is in the call), or it was closed (completed, cancelled,
 *              missed), or it is a proposal past its expiry.
 *
 * Display status (`display_status`, `display_label`, `display_detail`):
 *  upcoming | live | finalising | completed | cancelled | missed |
 *  not_confirmed | expired — with a short label and an optional detail line
 *  worded for the viewer (`$audience`: patient | doctor | staff), e.g. a
 *  patient's missed visit reads "You didn't join" / "Doctor didn't attend" /
 *  "Neither joined", an unconfirmed one "Doctor didn't confirm in time".
 */
final class AppointmentLifecycle
{
    /** A started consultation counts as live until this long after its slot ends. */
    public const LIVE_GRACE_MINUTES = 30;
    /** A doctor may confirm a request until this long after its slot ends. */
    public const CONFIRM_GRACE_MINUTES = 30;
    /** Presence counts towards who came from this long before the start… */
    public const PRESENCE_EARLY_MINUTES = 15;
    /** …until this long after the slot ends. */
    public const PRESENCE_LATE_MINUTES = 30;
    /** Someone who arrived within this long of the start was on time (who-didn't-come rules). */
    public const ON_TIME_MINUTES = 15;

    /** The patient's reschedule inside the late-cancellation window (422 errors.status). */
    public const TOO_LATE_TO_MOVE = 'Too close to the start to move it';

    public const PHASES          = ['upcoming', 'live', 'past'];
    public const DISPLAY_STATUSES = ['upcoming', 'live', 'finalising', 'completed', 'cancelled', 'missed', 'not_confirmed', 'expired'];
    public const AUDIENCES       = ['patient', 'doctor', 'staff'];
    /** `appointments.no_show`: who didn't come to a missed consultation. */
    public const NO_SHOWS = ['doctor', 'patient', 'both'];
    /** Who moved a consultation last (`appointments.rescheduled_by`). */
    public const RESCHEDULERS = ['patient', 'doctor', 'staff'];

    /**
     * `appointments.closure_reason` — why a consultation was closed when it
     * wasn't closed by an ordinary patient / doctor action (null then):
     *  expired_unconfirmed  the doctor never confirmed it before it ended (cancelled, full refund)
     *  no_show              someone didn't come (missed; `no_show` says who)
     *  auto_completed       closed by the cron on proof it took place
     *  staff_cancelled      cancelled by the back office
     *  staff_completed      marked held by the back office
     */
    public const CLOSURE_REASONS = ['expired_unconfirmed', 'no_show', 'auto_completed', 'staff_cancelled', 'staff_completed'];

    /** When the booked slot ends (the doctor's slot length after the start). */
    public static function endsAt(Appointment $appointment): DateTimeImmutable
    {
        return $appointment->getScheduledAt()->modify('+' . $appointment->getSpecialist()->getSlotMinutes() . ' minutes');
    }

    /** Whether its start time has come. */
    public static function hasStarted(Appointment $appointment, DateTimeImmutable $now): bool
    {
        return $now >= $appointment->getScheduledAt();
    }

    /** upcoming | live | past (see the class doc). `$inCall`: someone is in its call right now. */
    public static function phase(Appointment $appointment, DateTimeImmutable $now, bool $inCall = false): string
    {
        $status = $appointment->getStatus();
        if ($status->isTerminal()) {
            return 'past';
        }
        if ($status === AppointmentStatus::PROPOSED) {
            $expires = $appointment->getExpiresAt();

            return $expires !== null && $expires <= $now ? 'past' : 'upcoming';
        }
        if ($inCall) {
            return 'live';
        }
        if ($now < $appointment->getScheduledAt()) {
            return 'upcoming';
        }

        return $now < self::endsAt($appointment)->modify('+' . self::LIVE_GRACE_MINUTES . ' minutes') ? 'live' : 'past';
    }

    /**
     * A past booking still open — pending, confirmed or rescheduled after it
     * ended: the cron closes it (or the back office resolves it).
     */
    public static function needsAttention(Appointment $appointment, DateTimeImmutable $now, bool $inCall = false): bool
    {
        return $appointment->getStatus()->isOpenBooking() && self::phase($appointment, $now, $inCall) === 'past';
    }

    /**
     * How to show it: [display_status, display_label, display_detail].
     *
     * @return array{0:string, 1:string, 2:?string}
     */
    public static function display(Appointment $appointment, DateTimeImmutable $now, string $audience = 'patient', bool $inCall = false): array
    {
        $status = $appointment->getStatus();

        if ($status === AppointmentStatus::COMPLETED) {
            return ['completed', 'Completed', null];
        }
        if ($status === AppointmentStatus::MISSED) {
            return ['missed', 'Missed', self::noShowDetail($appointment->getNoShow(), $audience)];
        }
        if ($status === AppointmentStatus::CANCELLED) {
            if ($appointment->getClosureReason() === 'expired_unconfirmed') {
                return ['not_confirmed', 'Not confirmed', self::unconfirmedDetail($audience)];
            }

            return match ($appointment->getFollowUpOutcome()) {
                'expired'   => ['expired', 'Expired', $audience === 'patient' ? 'You didn\'t reply in time' : 'Not taken up in time'],
                'declined'  => ['cancelled', 'Declined', null],
                'withdrawn' => ['cancelled', 'Withdrawn', null],
                default     => ['cancelled', 'Cancelled', null],
            };
        }

        $phase = self::phase($appointment, $now, $inCall);
        if ($phase === 'live') {
            return ['live', 'In progress', null];
        }
        if ($phase === 'past') {
            if ($status === AppointmentStatus::PROPOSED) {
                return ['expired', 'Expired', null];
            }
            // An unconfirmed one both sides came to (first heartbeats inside
            // this slot's presence window) is never expired by the cron
            // (PastAppointmentCloser::expiredUnconfirmedQuery()): it is
            // completed on proof, or left for the back office.
            if ($status !== AppointmentStatus::CONFIRMED && !self::bothJoined($appointment)) {
                return ['not_confirmed', 'Not confirmed', self::unconfirmedDetail($audience)];
            }

            return ['finalising', 'Being finalised', null];
        }

        return ['upcoming', $status->label(), self::upcomingDetail($appointment, $audience)];
    }

    /** "You didn't join" / "Doctor didn't attend" / "Neither joined", worded for the viewer. */
    public static function noShowDetail(?string $noShow, string $audience): ?string
    {
        return match ($noShow) {
            'both'    => 'Neither joined',
            'patient' => $audience === 'patient' ? "You didn't join" : "Patient didn't join",
            'doctor'  => $audience === 'doctor' ? "You didn't attend" : "Doctor didn't attend",
            default   => null,
        };
    }

    private static function unconfirmedDetail(string $audience): string
    {
        return $audience === 'doctor' ? "You didn't confirm in time" : "Doctor didn't confirm in time";
    }

    private static function upcomingDetail(Appointment $appointment, string $audience): ?string
    {
        return match ($appointment->getStatus()) {
            AppointmentStatus::PENDING, AppointmentStatus::RESCHEDULED => $audience === 'doctor'
                ? 'Awaiting your confirmation'
                : 'Awaiting doctor confirmation',
            AppointmentStatus::PROPOSED  => $audience === 'patient' ? 'Awaiting your reply' : 'Awaiting patient',
            AppointmentStatus::CONFIRMED => $audience === 'patient' && $appointment->getRescheduledBy() === 'doctor'
                ? 'Your doctor moved this consultation'
                : null,
            default => null,
        };
    }

    // ----- Rules -----

    /**
     * Why the patient can't cancel or reschedule now, or null. Open bookings
     * only, and only before the start: after it the outcome is decided by the
     * consultation being completed or marked missed.
     */
    public static function patientChangeProblem(Appointment $appointment, DateTimeImmutable $now): ?string
    {
        if (!$appointment->getStatus()->isOpenBooking()) {
            return null; // the actions answer the other statuses themselves
        }

        return self::hasStarted($appointment, $now) ? 'This consultation has started' : null;
    }

    /**
     * Whether the late-cancellation window applies to this booking now: a
     * confirmed consultation within `$lateCancelHours` of its start (0 = no
     * late window). Never to a request the doctor hasn't confirmed, nor to one
     * the doctor moved (`rescheduled_by` doctor) — the patient was promised
     * they could cancel or move that one for a full refund until it starts.
     */
    public static function inLateWindow(Appointment $appointment, DateTimeImmutable $now, int $lateCancelHours): bool
    {
        if (
            $lateCancelHours <= 0
            || $appointment->getStatus() !== AppointmentStatus::CONFIRMED
            || $appointment->getRescheduledBy() === 'doctor'
        ) {
            return false;
        }

        return $now >= $appointment->getScheduledAt()->modify('-' . $lateCancelHours . ' hours');
    }

    /**
     * What share of the consultation fee a patient's cancellation (before the
     * start) refunds: 100, except inside the late window ({@see inLateWindow()}),
     * which refunds `$lateCancelRefundPct`. A request the doctor never
     * confirmed, or a booking the doctor moved, always refunds in full. Guest
     * fees always go back in full.
     */
    public static function cancelRefundPercent(Appointment $appointment, DateTimeImmutable $now, int $lateCancelHours, int $lateCancelRefundPct): int
    {
        return self::inLateWindow($appointment, $now, $lateCancelHours) ? max(0, min(100, $lateCancelRefundPct)) : 100;
    }

    /**
     * Why the patient can't move this booking now, or null: after its start
     * ({@see patientChangeProblem()}), or inside the late window — moving it
     * first would dodge the late-cancellation share.
     */
    public static function patientRescheduleProblem(Appointment $appointment, DateTimeImmutable $now, int $lateCancelHours): ?string
    {
        if (($started = self::patientChangeProblem($appointment, $now)) !== null) {
            return $started;
        }

        return self::inLateWindow($appointment, $now, $lateCancelHours) ? self::TOO_LATE_TO_MOVE : null;
    }

    /**
     * What a partial refund gives back: every guest fee, plus `$percent` of the
     * rest (the consultation fee) — a missed consultation, a late cancellation.
     */
    public static function partialRefund(Appointment $appointment, int $percent): string
    {
        $guests  = $appointment->guestFeesTotal();
        $consult = bcsub($appointment->getAmount(), $guests, 2);
        $share   = bcdiv(bcmul($consult, (string) max(0, min(100, $percent)), 4), '100', 2);

        return bcadd($guests, $share, 2);
    }

    /** Why the doctor can't confirm this request now (it ended over CONFIRM_GRACE_MINUTES ago), or null. */
    public static function doctorConfirmProblem(Appointment $appointment, DateTimeImmutable $now): ?string
    {
        $last = self::endsAt($appointment)->modify('+' . self::CONFIRM_GRACE_MINUTES . ' minutes');

        return $now > $last ? 'This consultation has ended, so it can no longer be confirmed' : null;
    }

    /**
     * Why the doctor can't decline / cancel this booking now, or null: a
     * confirmed one only before its start (after it, it closes as completed
     * or missed — a doctor who didn't attend can't turn a no-show into a
     * full-refund cancellation); a request (pending / rescheduled) until
     * CONFIRM_GRACE_MINUTES after its slot ended, as long as it could be
     * confirmed (then the cron expires it).
     */
    public static function doctorDeclineProblem(Appointment $appointment, DateTimeImmutable $now): ?string
    {
        if ($appointment->getStatus() === AppointmentStatus::CONFIRMED) {
            return self::hasStarted($appointment, $now)
                ? 'This consultation has started, so it can no longer be cancelled — it closes as completed or missed'
                : null;
        }
        $last = self::endsAt($appointment)->modify('+' . self::CONFIRM_GRACE_MINUTES . ' minutes');

        return $now > $last ? 'This consultation has ended, so it can no longer be declined' : null;
    }

    /** Why the doctor can't move this booking now (its slot ended over CONFIRM_GRACE_MINUTES ago), or null. */
    public static function doctorRescheduleProblem(Appointment $appointment, DateTimeImmutable $now): ?string
    {
        $last = self::endsAt($appointment)->modify('+' . self::CONFIRM_GRACE_MINUTES . ' minutes');

        return $now > $last ? 'This consultation has ended, so it can no longer be moved' : null;
    }

    /** The window in which being on the call counts towards who came: [start - 15 min, end + 30 min]. @return array{0:DateTimeImmutable, 1:DateTimeImmutable} */
    public static function presenceWindow(Appointment $appointment): array
    {
        return [
            $appointment->getScheduledAt()->modify('-' . self::PRESENCE_EARLY_MINUTES . ' minutes'),
            self::endsAt($appointment)->modify('+' . self::PRESENCE_LATE_MINUTES . ' minutes'),
        ];
    }

    public static function inPresenceWindow(Appointment $appointment, ?DateTimeImmutable $at): bool
    {
        if ($at === null) {
            return false;
        }
        [$from, $to] = self::presenceWindow($appointment);

        return $at >= $from && $at <= $to;
    }

    /**
     * Both sides' first-join stamps fall inside this slot's presence window —
     * they each opened the call. An unconfirmed booking like that is never
     * expired as "not confirmed" (it shows "Being finalised" until it is
     * completed on proof or resolved by the back office).
     */
    public static function bothJoined(Appointment $appointment): bool
    {
        return self::inPresenceWindow($appointment, $appointment->getDoctorFirstJoinedAt())
            && self::inPresenceWindow($appointment, $appointment->getPatientFirstJoinedAt());
    }

    /**
     * Who didn't come to a consultation with no proof it took place, from each
     * side's presence inside the window (first and last sign of them: call
     * samples, transcript lines, the first-join stamps). "On time" = first
     * seen by ON_TIME_MINUTES after the start:
     *  - neither came → both;
     *  - only one came → the other, when the one who came was on time, else
     *    both (a lone late arrival — e.g. opening the call page long after —
     *    never earns the fee or blames the other side);
     *  - both came but never together → the one who arrived after the other
     *    had left, when the other was on time AND still there at the start;
     *    otherwise (the other left before the start) the earlier one didn't
     *    really come either: the later one blames them when on time, else both;
     *  - their times overlap (they may have met; the proof is missing): null —
     *    left open for the back office to resolve.
     *
     * @param array{first:?DateTimeImmutable, last:?DateTimeImmutable} $doctor
     * @param array{first:?DateTimeImmutable, last:?DateTimeImmutable} $patient
     */
    public static function noShowParty(array $doctor, array $patient, DateTimeImmutable $start): ?string
    {
        $doctorCame  = $doctor['first'] !== null;
        $patientCame = $patient['first'] !== null;
        if (!$doctorCame && !$patientCame) {
            return 'both';
        }

        $onTime = $start->modify('+' . self::ON_TIME_MINUTES . ' minutes');
        if (!$doctorCame) {
            return $patient['first'] <= $onTime ? 'doctor' : 'both';
        }
        if (!$patientCame) {
            return $doctor['first'] <= $onTime ? 'patient' : 'both';
        }

        $doctorLast  = $doctor['last'] ?? $doctor['first'];
        $patientLast = $patient['last'] ?? $patient['first'];
        if ($doctor['first'] > $patientLast) {
            // The doctor arrived after the patient had left.
            if ($patient['first'] <= $onTime && $patientLast >= $start) {
                return 'doctor';
            }

            return $doctor['first'] <= $onTime ? 'patient' : 'both';
        }
        if ($patient['first'] > $doctorLast) {
            // The patient arrived after the doctor had left.
            if ($doctor['first'] <= $onTime && $doctorLast >= $start) {
                return 'patient';
            }

            return $patient['first'] <= $onTime ? 'doctor' : 'both';
        }

        return null;
    }
}
