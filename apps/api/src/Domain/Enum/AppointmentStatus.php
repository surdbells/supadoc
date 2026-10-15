<?php

declare(strict_types=1);

namespace App\Domain\Enum;

/**
 * Appointment lifecycle as a backed enum that owns its state machine. Putting
 * transitions on the enum makes an illegal state change impossible to express,
 * not merely discouraged (see ARCHITECTURE §6).
 *
 * PROPOSED is a follow-up the doctor offered and the patient hasn't answered:
 * it holds the slot until it expires, but is not a booking yet — no reminders,
 * no call, no completion, no earnings. Only the patient's acceptance (which
 * takes the payment) moves it to CONFIRMED; declining, the doctor withdrawing
 * it or the expiry cron move it to CANCELLED.
 *
 * MISSED is a confirmed consultation whose time passed with no sign it took
 * place (the reminders cron closes it, {@see \App\Infrastructure\Service\PastAppointmentCloser});
 * `appointments.no_show` says who didn't come (doctor | patient | both). It is
 * terminal for patients and doctors. The system and the back office have a few
 * more moves ({@see privilegedTransitions()}): a visit that took place without
 * being confirmed can be COMPLETED, a confirmed one can be marked MISSED, and a
 * MISSED one can be resolved as held (COMPLETED) or CANCELLED.
 */
enum AppointmentStatus: string
{
    case PROPOSED    = 'proposed';
    case PENDING     = 'pending';
    case CONFIRMED   = 'confirmed';
    case RESCHEDULED = 'rescheduled';
    case COMPLETED   = 'completed';
    case CANCELLED   = 'cancelled';
    case MISSED      = 'missed';

    /** The moves patients, doctors and ordinary staff edits may make. @return list<self> */
    public function allowedTransitions(): array
    {
        return match ($this) {
            self::PROPOSED    => [self::CONFIRMED, self::CANCELLED],
            self::PENDING     => [self::CONFIRMED, self::RESCHEDULED, self::CANCELLED],
            self::CONFIRMED   => [self::COMPLETED, self::RESCHEDULED, self::CANCELLED],
            self::RESCHEDULED => [self::CONFIRMED, self::CANCELLED],
            self::COMPLETED, self::CANCELLED, self::MISSED => [], // terminal
        };
    }

    /**
     * The extra moves only the system (the reminders cron) and the back office
     * may make, on top of {@see allowedTransitions()}: complete a visit that
     * took place unconfirmed, mark a past visit missed, and resolve a missed
     * one as held or cancelled.
     *
     * @return list<self>
     */
    public function privilegedTransitions(): array
    {
        return match ($this) {
            self::PENDING, self::RESCHEDULED => [self::COMPLETED, self::MISSED],
            self::CONFIRMED                  => [self::MISSED],
            self::MISSED                     => [self::COMPLETED, self::CANCELLED],
            self::PROPOSED, self::COMPLETED, self::CANCELLED => [],
        };
    }

    /** `$privileged`: the system or the back office is moving it ({@see privilegedTransitions()}). */
    public function canTransitionTo(self $target, bool $privileged = false): bool
    {
        return in_array($target, $this->allowedTransitions(), true)
            || ($privileged && in_array($target, $this->privilegedTransitions(), true));
    }

    /** Closed for patients and doctors: completed, cancelled or missed. */
    public function isTerminal(): bool
    {
        return $this->allowedTransitions() === [];
    }

    /** A booking still waiting to take place or be closed: pending, confirmed or rescheduled. */
    public function isOpenBooking(): bool
    {
        return in_array($this, self::openBookings(), true);
    }

    /** @return list<self> pending, confirmed, rescheduled */
    public static function openBookings(): array
    {
        return [self::PENDING, self::CONFIRMED, self::RESCHEDULED];
    }

    /** @return list<self> completed, cancelled, missed */
    public static function terminal(): array
    {
        return [self::COMPLETED, self::CANCELLED, self::MISSED];
    }

    public function label(): string
    {
        return match ($this) {
            self::PROPOSED    => 'Proposed',
            self::PENDING     => 'Pending',
            self::CONFIRMED   => 'Confirmed',
            self::RESCHEDULED => 'Rescheduled',
            self::COMPLETED   => 'Completed',
            self::CANCELLED   => 'Cancelled',
            self::MISSED      => 'Missed',
        };
    }
}
