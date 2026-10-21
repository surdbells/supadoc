<?php

declare(strict_types=1);

namespace App\Domain\Settings;

use DateTimeImmutable;
use DateTimeZone;

/**
 * The PHP process clock (php.ini date.timezone — PRC in production, UTC locally).
 * Every timestamp column is naive and is read back in this zone, so an instant
 * must be expressed in it before it is stored or compared as a wall-clock time.
 * Not cached: tests switch the process zone.
 */
final class ProcessClock
{
    public static function zone(): DateTimeZone
    {
        return new DateTimeZone(date_default_timezone_get());
    }

    /** The same instant, in the process zone. */
    public static function normalize(DateTimeImmutable $at): DateTimeImmutable
    {
        return $at->setTimezone(self::zone());
    }
}
