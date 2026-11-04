<?php

declare(strict_types=1);

namespace App\Domain\Settings;

use DateTimeImmutable;
use DateTimeInterface;
use DateTimeZone;

/**
 * IANA time zones for people: validation, the effective zone, and the labels
 * the server writes ("Wed 4 Nov, 9:00 AM CST") — pure.
 *
 * Labels are built from numbers and the fixed English arrays {@see DAYS} /
 * {@see MONTHS}, and abbreviations from {@see ABBR} (else "GMT±H[:MM]"), never
 * from PHP's `T`, `D` or `M` — so they match the TypeScript helpers in
 * `libs/shared/data-access/src/lib/time-zone.ts` exactly (a shared JSON fixture
 * checks both). Wall-clock helpers are DST-safe: a local day is 23 or 25 hours
 * where it has to be.
 */
final class TimeZones
{
    /** Shared with TS ZONE_ABBR — keep identical (fixture-tested). [standard, daylight]. */
    public const ABBR = [
        'Africa/Lagos'       => ['WAT', 'WAT'],
        'Africa/Porto-Novo'  => ['WAT', 'WAT'],
        'Africa/Douala'      => ['WAT', 'WAT'],
        'Africa/Niamey'      => ['WAT', 'WAT'],
        'Africa/Ndjamena'    => ['WAT', 'WAT'],
        'Africa/Malabo'      => ['WAT', 'WAT'],
        'Africa/Libreville'  => ['WAT', 'WAT'],
        'Africa/Luanda'      => ['WAT', 'WAT'],
        'Africa/Kinshasa'    => ['WAT', 'WAT'],
        'Africa/Brazzaville' => ['WAT', 'WAT'],
        'Africa/Bangui'      => ['WAT', 'WAT'],

        'Africa/Accra'       => ['GMT', 'GMT'],
        'Africa/Abidjan'     => ['GMT', 'GMT'],
        'Africa/Dakar'       => ['GMT', 'GMT'],
        'Africa/Freetown'    => ['GMT', 'GMT'],
        'Africa/Monrovia'    => ['GMT', 'GMT'],
        'Africa/Bamako'      => ['GMT', 'GMT'],
        'Africa/Banjul'      => ['GMT', 'GMT'],
        'Africa/Conakry'     => ['GMT', 'GMT'],
        'Africa/Lome'        => ['GMT', 'GMT'],
        'Africa/Ouagadougou' => ['GMT', 'GMT'],
        'Atlantic/Reykjavik' => ['GMT', 'GMT'],

        'UTC'                => ['UTC', 'UTC'],
        'Etc/UTC'            => ['UTC', 'UTC'],

        'Africa/Nairobi'       => ['EAT', 'EAT'],
        'Africa/Addis_Ababa'   => ['EAT', 'EAT'],
        'Africa/Dar_es_Salaam' => ['EAT', 'EAT'],
        'Africa/Kampala'       => ['EAT', 'EAT'],
        'Africa/Mogadishu'     => ['EAT', 'EAT'],
        'Africa/Djibouti'      => ['EAT', 'EAT'],
        'Africa/Asmara'        => ['EAT', 'EAT'],
        'Africa/Asmera'        => ['EAT', 'EAT'],

        'Africa/Maputo'     => ['CAT', 'CAT'],
        'Africa/Harare'     => ['CAT', 'CAT'],
        'Africa/Lusaka'     => ['CAT', 'CAT'],
        'Africa/Kigali'     => ['CAT', 'CAT'],
        'Africa/Blantyre'   => ['CAT', 'CAT'],
        'Africa/Gaborone'   => ['CAT', 'CAT'],
        'Africa/Bujumbura'  => ['CAT', 'CAT'],
        'Africa/Lubumbashi' => ['CAT', 'CAT'],

        'Africa/Johannesburg' => ['SAST', 'SAST'],
        'Africa/Maseru'       => ['SAST', 'SAST'],
        'Africa/Mbabane'      => ['SAST', 'SAST'],

        'Africa/Cairo'     => ['EET', 'EEST'],
        'Europe/Athens'    => ['EET', 'EEST'],
        'Europe/Helsinki'  => ['EET', 'EEST'],
        'Europe/Kyiv'      => ['EET', 'EEST'],
        'Europe/Kiev'      => ['EET', 'EEST'],
        'Europe/Bucharest' => ['EET', 'EEST'],

        'Europe/London' => ['GMT', 'BST'],
        'Europe/Dublin' => ['GMT', 'IST'],
        'Europe/Lisbon' => ['WET', 'WEST'],

        'Europe/Berlin'     => ['CET', 'CEST'],
        'Europe/Paris'      => ['CET', 'CEST'],
        'Europe/Madrid'     => ['CET', 'CEST'],
        'Europe/Rome'       => ['CET', 'CEST'],
        'Europe/Amsterdam'  => ['CET', 'CEST'],
        'Europe/Brussels'   => ['CET', 'CEST'],
        'Europe/Vienna'     => ['CET', 'CEST'],
        'Europe/Zurich'     => ['CET', 'CEST'],
        'Europe/Stockholm'  => ['CET', 'CEST'],
        'Europe/Oslo'       => ['CET', 'CEST'],
        'Europe/Copenhagen' => ['CET', 'CEST'],
        'Europe/Warsaw'     => ['CET', 'CEST'],
        'Europe/Prague'     => ['CET', 'CEST'],
        'Europe/Budapest'   => ['CET', 'CEST'],

        'Asia/Kolkata'  => ['IST', 'IST'],
        'Asia/Calcutta' => ['IST', 'IST'],

        'America/New_York'             => ['EST', 'EDT'],
        'America/Detroit'              => ['EST', 'EDT'],
        'America/Toronto'              => ['EST', 'EDT'],
        'America/Indiana/Indianapolis' => ['EST', 'EDT'],
        'America/Indianapolis'         => ['EST', 'EDT'],

        'America/Chicago'  => ['CST', 'CDT'],
        'America/Winnipeg' => ['CST', 'CDT'],

        'America/Denver'   => ['MST', 'MDT'],
        'America/Edmonton' => ['MST', 'MDT'],
        'America/Boise'    => ['MST', 'MDT'],
        'America/Phoenix'  => ['MST', 'MST'],

        'America/Los_Angeles' => ['PST', 'PDT'],
        'America/Vancouver'   => ['PST', 'PDT'],

        'America/Anchorage' => ['AKST', 'AKDT'],
        'Pacific/Honolulu'  => ['HST', 'HST'],
        'America/Halifax'   => ['AST', 'ADT'],
        'America/St_Johns'  => ['NST', 'NDT'],
    ];

    /** Never auto-detected (privacy browsers, VPNs and failed detection report these); all stay valid for a manual choice. */
    private const NOT_DETECTABLE = '/^(UTC|GMT|Universal|Zulu|Factory|Etc\/.*|Atlantic\/Reykjavik)$/';

    private const NAME = '/^[A-Za-z_]+(\/[A-Za-z0-9_+\-]+){0,2}$|^UTC$/';

    public const DAYS   = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    public const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    /** @var array<string,true>|null every IANA name PHP knows, aliases included */
    private static ?array $known = null;

    /**
     * A real IANA zone name (aliases browsers report, such as Asia/Calcutta,
     * included) — never a raw offset like "+01:00", which `new DateTimeZone()`
     * would accept.
     */
    public static function isValid(mixed $tz): bool
    {
        if (!is_string($tz)) {
            return false;
        }
        $tz = trim($tz);
        if ($tz === '' || strlen($tz) > 64 || preg_match(self::NAME, $tz) !== 1) {
            return false;
        }
        self::$known ??= array_fill_keys(DateTimeZone::listIdentifiers(DateTimeZone::ALL_WITH_BC), true);

        return isset(self::$known[$tz]);
    }

    /** Valid, and a zone an automatic detection may write (never UTC, GMT, Etc/*, Reykjavik…). */
    public static function isDetectable(mixed $tz): bool
    {
        return self::isValid($tz) && preg_match(self::NOT_DETECTABLE, trim((string) $tz)) !== 1;
    }

    /** $tz as a zone when it is valid, else $fallback (default: the clinic's, {@see ClinicTime}). */
    public static function zoneOr(?string $tz, ?DateTimeZone $fallback = null): DateTimeZone
    {
        if ($tz !== null && self::isValid($tz)) {
            try {
                return new DateTimeZone(trim($tz));
            } catch (\Throwable) {
                // fall through
            }
        }

        return $fallback ?? ClinicTime::zone();
    }

    /**
     * "CST" / "CDT" for a mapped zone (daylight when the offset at $at is above
     * the smaller of mid-January's and mid-July's), else "GMT", "GMT+4",
     * "GMT-3", "GMT+5:45".
     */
    public static function abbr(DateTimeInterface $at, DateTimeZone $z): string
    {
        $instant = DateTimeImmutable::createFromInterface($at);
        $off     = $z->getOffset($instant);
        $pair    = self::ABBR[$z->getName()] ?? null;
        if ($pair !== null) {
            $year = (int) $instant->setTimezone($z)->format('Y');
            $utc  = new DateTimeZone('UTC');
            $jan  = $z->getOffset(new DateTimeImmutable(sprintf('%04d-01-15 12:00:00', $year), $utc));
            $jul  = $z->getOffset(new DateTimeImmutable(sprintf('%04d-07-15 12:00:00', $year), $utc));

            return $off > min($jan, $jul) ? $pair[1] : $pair[0];
        }
        if ($off === 0) {
            return 'GMT';
        }
        $abs     = abs($off);
        $hours   = intdiv($abs, 3600);
        $minutes = intdiv($abs % 3600, 60);

        return 'GMT' . ($off < 0 ? '-' : '+') . $hours . ($minutes !== 0 ? ':' . sprintf('%02d', $minutes) : '');
    }

    /** Do the two zones have different UTC offsets at $at (EU and US DST weeks differ)? */
    public static function offsetsDiffer(DateTimeInterface $at, DateTimeZone $a, DateTimeZone $b): bool
    {
        $instant = DateTimeImmutable::createFromInterface($at);

        return $a->getOffset($instant) !== $b->getOffset($instant);
    }

    /** "9:00 AM CST". */
    public static function time(DateTimeInterface $at, DateTimeZone $z): string
    {
        return self::clock(self::parts($at, $z)) . ' ' . self::abbr($at, $z);
    }

    /** "Wed 4 Nov, 9:00 AM CST". */
    public static function when(DateTimeInterface $at, DateTimeZone $z): string
    {
        $p = self::parts($at, $z);

        return self::DAYS[$p['w']] . ' ' . $p['j'] . ' ' . self::MONTHS[$p['n'] - 1] . ', ' . self::clock($p) . ' ' . self::abbr($at, $z);
    }

    /** "Wed, 4 Nov 2026". */
    public static function date(DateTimeInterface $at, DateTimeZone $z): string
    {
        $p = self::parts($at, $z);

        return self::DAYS[$p['w']] . ', ' . $p['j'] . ' ' . self::MONTHS[$p['n'] - 1] . ' ' . $p['Y'];
    }

    /** "Wed, 4 Nov 2026 at 9:00 AM CST". */
    public static function dateTime(DateTimeInterface $at, DateTimeZone $z): string
    {
        return self::date($at, $z) . ' at ' . self::time($at, $z);
    }

    /** PDFs: "4 Nov 2026, 09:12 CST" (24-hour). */
    public static function stamp(DateTimeInterface $at, DateTimeZone $z): string
    {
        $p = self::parts($at, $z);

        return $p['j'] . ' ' . self::MONTHS[$p['n'] - 1] . ' ' . $p['Y'] . ', '
            . sprintf('%02d:%02d', $p['G'], $p['i']) . ' ' . self::abbr($at, $z);
    }

    /**
     * The primary label, plus " (4:00 PM WAT, your patient's time)" when the
     * other zone's offset differs at $at — with the other side's weekday when
     * its date differs: "(Thu 5:00 AM WAT, …)". `$whose` is the whole tail
     * ("your patient's time", "VideoMed time"). `$style`: 'when' | 'dateTime' | 'time'.
     */
    public static function dual(DateTimeInterface $at, DateTimeZone $primary, ?DateTimeZone $other, string $whose, string $style = 'when'): string
    {
        $label = match ($style) {
            'dateTime' => self::dateTime($at, $primary),
            'time'     => self::time($at, $primary),
            default    => self::when($at, $primary),
        };
        if ($other === null || !self::offsetsDiffer($at, $primary, $other)) {
            return $label;
        }
        $mine   = self::parts($at, $primary);
        $theirs = self::parts($at, $other);
        $day    = $mine['Y'] !== $theirs['Y'] || $mine['n'] !== $theirs['n'] || $mine['j'] !== $theirs['j']
            ? self::DAYS[$theirs['w']] . ' '
            : '';
        $tail   = $whose !== '' ? ', ' . $whose : '';

        return $label . ' (' . $day . self::time($at, $other) . $tail . ')';
    }

    /** The zone's calendar date of an instant, Y-m-d. */
    public static function localDate(int $ts, DateTimeZone $z): string
    {
        return (new DateTimeImmutable('@' . $ts))->setTimezone($z)->format('Y-m-d');
    }

    /**
     * [local midnight, next local midnight) as unix seconds — 23 or 25 hours on
     * a DST day (where midnight itself is skipped, the day starts when it resumes).
     *
     * @return array{0:int,1:int}
     */
    public static function localDayBounds(string $ymd, DateTimeZone $z): array
    {
        return [self::resolveWall($ymd, 0, $z), self::resolveWall(self::nextYmd($ymd), 0, $z)];
    }

    /**
     * Wall clock → instant. $minutes 0..1440, where 1440 is the next local
     * midnight. A time that doesn't exist (spring forward) rolls forward like
     * PHP (02:30 → 03:30); an ambiguous one (fall back) takes the first
     * occurrence — in every zone, as the TS `zonedLocalToIso` does. (PHP's own
     * parser takes the first in American zones but the second in European and
     * Australian ones: London's 01:30 on 2026-10-25 would be 01:30Z, not 00:30Z.)
     */
    public static function wallToInstant(string $ymd, int $minutes, DateTimeZone $z): int
    {
        if ($minutes >= 1440) {
            return self::localDayBounds($ymd, $z)[1];
        }

        return self::resolveWall($ymd, max(0, $minutes), $z);
    }

    /**
     * The instant of wall clock `$ymd` + `$minutes` (0..1439) in `$z`, judged
     * from the zone's offsets a day either side (which covers any transition):
     * equal → no change near; otherwise the offsets that really hold at their
     * candidate instant — both on a fall-back hour (take the earlier), none in a
     * spring-forward gap (read with the offset before the change: rolls forward).
     */
    private static function resolveWall(string $ymd, int $minutes, DateTimeZone $z): int
    {
        $wall   = (new DateTimeImmutable(sprintf('%s %02d:%02d', $ymd, intdiv($minutes, 60), $minutes % 60), new DateTimeZone('UTC')))->getTimestamp();
        $before = $z->getOffset(new DateTimeImmutable('@' . ($wall - 86400)));
        $after  = $z->getOffset(new DateTimeImmutable('@' . ($wall + 86400)));
        if ($before === $after) {
            return $wall - $before;
        }
        $fits = [];
        foreach ([$before, $after] as $offset) {
            $at = $wall - $offset;
            if ($z->getOffset(new DateTimeImmutable('@' . $at)) === $offset) {
                $fits[] = $at;
            }
        }

        return $fits !== [] ? min($fits) : $wall - $before;
    }

    /** Minutes since local midnight of the instant's wall clock in $z (0..1439). */
    public static function minutesOfDay(int $ts, DateTimeZone $z): int
    {
        $local = (new DateTimeImmutable('@' . $ts))->setTimezone($z);

        return ((int) $local->format('G')) * 60 + (int) $local->format('i');
    }

    /** @return array{Y:int, n:int, j:int, w:int, G:int, i:int} */
    private static function parts(DateTimeInterface $at, DateTimeZone $z): array
    {
        $local = DateTimeImmutable::createFromInterface($at)->setTimezone($z);
        [$y, $n, $j, $w, $g, $i] = array_map('intval', explode(' ', $local->format('Y n j w G i')));

        return ['Y' => $y, 'n' => $n, 'j' => $j, 'w' => $w, 'G' => $g, 'i' => $i];
    }

    /** "9:00 AM" from the numeric hour and minute (ASCII space). @param array{G:int, i:int} $p */
    private static function clock(array $p): string
    {
        return ($p['G'] % 12 ?: 12) . ':' . sprintf('%02d', $p['i']) . ' ' . ($p['G'] < 12 ? 'AM' : 'PM');
    }

    private static function nextYmd(string $ymd): string
    {
        return (new DateTimeImmutable($ymd, new DateTimeZone('UTC')))->modify('+1 day')->format('Y-m-d');
    }
}
