<?php

declare(strict_types=1);

namespace App\Domain\Enum;

/** Category of a patient notification — drives the icon/tint on the client. */
enum NotificationType: string
{
    case APPOINTMENT  = 'appointment';
    case PRESCRIPTION = 'prescription';
    case PAYMENT      = 'payment';
    case SYSTEM       = 'system';

    public function label(): string
    {
        return match ($this) {
            self::APPOINTMENT  => 'Appointment',
            self::PRESCRIPTION => 'Prescription',
            self::PAYMENT      => 'Payment',
            self::SYSTEM       => 'System',
        };
    }
}
