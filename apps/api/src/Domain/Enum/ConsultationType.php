<?php

declare(strict_types=1);

namespace App\Domain\Enum;

/** How a consultation is delivered. */
enum ConsultationType: string
{
    case VIDEO     = 'video';
    case FOLLOW_UP = 'follow_up';
    case URGENT    = 'urgent';
    case ROUTINE   = 'routine';

    public function label(): string
    {
        return match ($this) {
            self::VIDEO     => 'Video Consultation',
            self::FOLLOW_UP => 'Patient Follow-up',
            self::URGENT    => 'Urgent Care',
            self::ROUTINE   => 'Routine Checkup',
        };
    }
}
