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
 */
enum AppointmentStatus: string
{
    case PROPOSED    = 'proposed';
    case PENDING     = 'pending';
    case CONFIRMED   = 'confirmed';
    case RESCHEDULED = 'rescheduled';
    case COMPLETED   = 'completed';
    case CANCELLED   = 'cancelled';

    /** @return list<self> */
    public function allowedTransitions(): array
    {
        return match ($this) {
            self::PROPOSED    => [self::CONFIRMED, self::CANCELLED],
            self::PENDING     => [self::CONFIRMED, self::RESCHEDULED, self::CANCELLED],
            self::CONFIRMED   => [self::COMPLETED, self::RESCHEDULED, self::CANCELLED],
            self::RESCHEDULED => [self::CONFIRMED, self::CANCELLED],
            self::COMPLETED, self::CANCELLED => [], // terminal
        };
    }

    public function canTransitionTo(self $target): bool
    {
        return in_array($target, $this->allowedTransitions(), true);
    }

    public function isTerminal(): bool
    {
        return $this->allowedTransitions() === [];
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
        };
    }
}
