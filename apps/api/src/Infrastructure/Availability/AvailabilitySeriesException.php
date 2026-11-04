<?php

declare(strict_types=1);

namespace App\Infrastructure\Availability;

/** Why {@see AvailabilitySeries::expand()} refused: a 422 field and its message. */
final class AvailabilitySeriesException extends \DomainException
{
    private function __construct(public readonly string $field, string $message, public readonly int $total = 0)
    {
        parent::__construct($message);
    }

    public static function none(): self
    {
        return new self('date', 'None of the chosen days fall in this period');
    }

    public static function tooMany(int $total): self
    {
        return new self(
            'end',
            'That adds ' . number_format($total) . ' times — the most at once is 4,000. Choose fewer weeks or a shorter time range.',
            $total,
        );
    }
}
