<?php

declare(strict_types=1);

namespace App\Domain\Application;

/**
 * Application reference numbers, `GVM-DR-{YYYY}-{NNNNN}` (spec §2.9, D7): the
 * clinic year at submit and a RANDOM 10000–99999 (so the numbers don't reveal
 * how many applications arrive). Assigned inside the submit transaction by
 * DoctorApplicationService under an advisory lock; the unique index is the
 * backstop.
 */
final class ApplicationReference
{
    public const PATTERN = '/^GVM-DR-\d{4}-\d{5}$/';

    public const MIN = 10000;
    public const MAX = 99999;

    public static function format(int $year, int $n): string
    {
        return sprintf('GVM-DR-%04d-%05d', $year, $n);
    }

    /** What a person typed, made comparable: trimmed, upper-cased, runs of spaces as "-". */
    public static function normalise(string $raw): string
    {
        $s = strtoupper(trim($raw));

        return (string) preg_replace('/\s+/', '-', $s);
    }

    public static function isValid(string $reference): bool
    {
        return preg_match(self::PATTERN, $reference) === 1;
    }

    /** A random candidate number for `$year`. */
    public static function candidate(int $year): string
    {
        return self::format($year, random_int(self::MIN, self::MAX));
    }
}
