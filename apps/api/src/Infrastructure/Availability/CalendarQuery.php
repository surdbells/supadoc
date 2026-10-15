<?php

declare(strict_types=1);

namespace App\Infrastructure\Availability;

use App\Domain\Exception\ValidationException;

/**
 * The query string of the booking-calendar endpoints — public, staff and the
 * doctor's own — read and checked in one place (pure, unit-tested). Failures
 * are a {@see ValidationException} (422 with field errors).
 *
 *   ?from=&to=  a month grid: `from` defaults to today and `to` to from + 41
 *               days; at most {@see MAX_DAYS} days, starting no earlier than
 *               MAX_DAYS before today and no later than the frame's last
 *               bookable date (so a request can never walk an unbounded run
 *               of dates — e.g. from=9999-12-31).
 *   ?date=      one day.
 */
final class CalendarQuery
{
    /** A 6-week month grid. */
    public const MAX_DAYS = 42;

    /**
     * The dates [from, to] a calendar request asks for, in $frame's zone.
     *
     * @param array<string,mixed> $query
     * @return array{0:string, 1:string}
     * @throws ValidationException
     */
    public static function range(array $query, BookingFrame $frame): array
    {
        $from = self::text($query, 'from');
        $to   = self::text($query, 'to');
        $from = $from === '' ? $frame->today : $from;

        $errors = [];
        if (!BookingFrame::isYmd($from)) {
            $errors['from'] = 'Enter a date as YYYY-MM-DD';
        }
        if ($to !== '' && !BookingFrame::isYmd($to)) {
            $errors['to'] = 'Enter a date as YYYY-MM-DD';
        }
        if ($errors !== []) {
            throw new ValidationException($errors);
        }

        $earliest = BookingFrame::addDays($frame->today, -self::MAX_DAYS);
        if ($from < $earliest || $from > $frame->bookableUntilDate) {
            throw new ValidationException(['from' => sprintf('Choose a start date from %s to %s', $earliest, $frame->bookableUntilDate)]);
        }
        $to   = $to === '' ? BookingFrame::addDays($from, self::MAX_DAYS - 1) : $to;
        $span = BookingFrame::daysBetween($from, $to);
        if ($span < 0) {
            throw new ValidationException(['to' => 'The end date must be on or after the start date']);
        }
        if ($span >= self::MAX_DAYS) {
            throw new ValidationException(['to' => 'Ask for at most ' . self::MAX_DAYS . ' days at a time']);
        }

        return [$from, $to];
    }

    /**
     * The one date a day-slots request asks for.
     *
     * @param array<string,mixed> $query
     * @throws ValidationException
     */
    public static function date(array $query): string
    {
        $date = self::text($query, 'date');
        if (!BookingFrame::isYmd($date)) {
            throw new ValidationException(['date' => 'Enter a date as YYYY-MM-DD']);
        }

        return $date;
    }

    /** @param array<string,mixed> $query */
    private static function text(array $query, string $key): string
    {
        return trim((string) (is_scalar($query[$key] ?? null) ? $query[$key] : ''));
    }
}
