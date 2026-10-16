<?php

declare(strict_types=1);

namespace App\Domain\Dashboard;

use DateTimeImmutable;
use DateTimeZone;

/**
 * The time windows of the back-office dashboard (GET /api/admin/dashboard),
 * worked out on the VIEWER's calendar (`?tz=`, default the clinic's zone):
 *
 *  - current:  `today` → local midnight … now; `7d` / `30d` → midnight 6 / 29
 *              days ago … now (today counts as one of the days);
 *  - previous: the same span one period earlier (`today` → yesterday midnight …
 *              this time yesterday), so a change compares like with like;
 *  - breakdown: the current period's first midnight … tomorrow's midnight (the
 *              whole of today, so a status breakdown includes what is still
 *              to come today);
 *  - trend:    the last 30 days, one bucket per local calendar day.
 *
 * Every instant is a DateTimeImmutable in the viewer's zone; the repository
 * converts them to the process zone the naive database timestamps are in.
 */
final class DashboardPeriod
{
    public const PERIODS = ['today', '7d', '30d'];

    public const DEFAULT_PERIOD = 'today';

    /** Days in the daily trend charts. */
    public const TREND_DAYS = 30;

    private function __construct(
        public readonly string $period,
        public readonly DateTimeZone $zone,
        public readonly DateTimeImmutable $now,
        public readonly DateTimeImmutable $from,
        public readonly DateTimeImmutable $previousFrom,
        public readonly DateTimeImmutable $previousTo,
        public readonly DateTimeImmutable $todayStart,
        public readonly DateTimeImmutable $tomorrowStart,
    ) {
    }

    /** A `?period=` value, normalised, or null when it is not one of {@see PERIODS}. */
    public static function parse(mixed $raw): ?string
    {
        $period = is_string($raw) ? strtolower(trim($raw)) : '';

        return in_array($period, self::PERIODS, true) ? $period : null;
    }

    public static function of(string $period, DateTimeZone $zone, ?DateTimeImmutable $now = null): self
    {
        $period = self::parse($period) ?? self::DEFAULT_PERIOD;
        $now    = ($now ?? new DateTimeImmutable('now'))->setTimezone($zone);
        $today  = $now->setTime(0, 0);
        $days   = match ($period) {
            '7d'    => 7,
            '30d'   => 30,
            default => 1,
        };
        $from  = $today->modify('-' . ($days - 1) . ' days');
        $shift = '-' . $days . ' days';

        return new self(
            $period,
            $zone,
            $now,
            $from,
            $from->modify($shift),
            $now->modify($shift),
            $today,
            $today->modify('+1 day'),
        );
    }

    /**
     * The KPI windows as half-open [from, to) bounds for the queries:
     * [from, currentEnd, previousFrom, previousEnd]. The ends are "now" (and
     * its counterpart one period back) moved up to the next whole second —
     * timestamps are stored to the second (rounded), so a row written in the
     * current second still counts.
     *
     * @return array{0: DateTimeImmutable, 1: DateTimeImmutable, 2: DateTimeImmutable, 3: DateTimeImmutable}
     */
    public function kpiWindows(): array
    {
        $ceil = static fn (DateTimeImmutable $t): DateTimeImmutable => $t
            ->setTime((int) $t->format('H'), (int) $t->format('i'), (int) $t->format('s'))
            ->modify('+1 second');

        return [$this->from, $ceil($this->now), $this->previousFrom, $ceil($this->previousTo)];
    }

    /** Length of the period in calendar days (1, 7 or 30). */
    public function days(): int
    {
        return match ($this->period) {
            '7d'    => 7,
            '30d'   => 30,
            default => 1,
        };
    }

    /**
     * The trend's day boundaries: TREND_DAYS + 1 local midnights, oldest first
     * (bucket i is [bounds[i], bounds[i + 1])); the last is tomorrow's.
     *
     * @return list<DateTimeImmutable>
     */
    public function trendBounds(): array
    {
        $bounds = [];
        for ($i = self::TREND_DAYS - 1; $i >= 0; $i--) {
            $bounds[] = $this->todayStart->modify('-' . $i . ' days');
        }
        $bounds[] = $this->tomorrowStart;

        return $bounds;
    }

    /** @return array{from: string, to: string, previous_from: string, previous_to: string} */
    public function toArray(): array
    {
        return [
            'from'          => $this->from->format(DATE_ATOM),
            'to'            => $this->now->format(DATE_ATOM),
            'previous_from' => $this->previousFrom->format(DATE_ATOM),
            'previous_to'   => $this->previousTo->format(DATE_ATOM),
        ];
    }
}
