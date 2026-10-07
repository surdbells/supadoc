<?php

declare(strict_types=1);

namespace App\Domain\Settings;

use DateTimeImmutable;
use DateTimeZone;

/**
 * The clinic's calendar (APP_TIMEZONE, default Africa/Lagos) for date-only
 * prescription rules — "today", valid-until, expiry, the date in the number.
 *
 * The process timezone is deliberately left alone (existing naive timestamps
 * depend on it). Date-only values are compared as Y-m-d strings, and "today"
 * is the clinic's date expressed at midnight in the process timezone — exactly
 * how Doctrine hydrates `date_immutable` columns — so comparisons line up
 * whatever php.ini says.
 */
final class ClinicTime
{
    private static ?DateTimeZone $zone = null;

    public static function configure(string $timezone): void
    {
        try {
            self::$zone = new DateTimeZone($timezone !== '' ? $timezone : 'Africa/Lagos');
        } catch (\Throwable) {
            self::$zone = new DateTimeZone('Africa/Lagos');
        }
    }

    public static function zone(): DateTimeZone
    {
        return self::$zone ??= new DateTimeZone('Africa/Lagos');
    }

    /** The current instant in the clinic's timezone. */
    public static function now(): DateTimeImmutable
    {
        return new DateTimeImmutable('now', self::zone());
    }

    /** The clinic's calendar date, Y-m-d. */
    public static function todayYmd(): string
    {
        return self::now()->format('Y-m-d');
    }

    /** The clinic's calendar date at midnight in the process timezone (like a hydrated date column). */
    public static function today(): DateTimeImmutable
    {
        return new DateTimeImmutable(self::todayYmd());
    }
}
