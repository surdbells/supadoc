<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Domain\Entity\Specialist;
use App\Domain\Settings\TimeZones;
use DateTimeZone;
use Doctrine\ORM\EntityManagerInterface;
use Psr\Http\Message\ResponseInterface;

/**
 * The zone contract of the doctor availability endpoints (list, add, block,
 * delete). The editor sends `tz` (body for POST, query for GET / DELETE):
 *
 *   - absent: an old cached editor — dates and "HH:MM" stay UTC wall clock,
 *     exactly as before (counted in the error log, no PII);
 *   - not a valid IANA zone: 422 `tz`;
 *   - valid but not the doctor's effective profile zone (a stale tab, or a
 *     zone changed in another window): 409 `timezone_changed` carrying the
 *     current zone — before anything is read or written, and again under the
 *     slot lock for a write ({@see zoneStillCurrent()}: a change that commits
 *     while the write waits for the lock);
 *   - otherwise the request's dates and times are wall clock in that zone.
 */
trait ReadsAvailabilityZone
{
    /**
     * @return array{zone: DateTimeZone, legacy: bool}|ResponseInterface the zone to read the request in, or the refusal to send
     */
    private function availabilityZone(ResponseInterface $response, Specialist $specialist, mixed $tz): array|ResponseInterface
    {
        if ($tz === null) {
            error_log('[availability] legacy-utc call');

            return ['zone' => new DateTimeZone('UTC'), 'legacy' => true];
        }
        if (!TimeZones::isValid($tz)) {
            return $this->error($response, 'Validation failed', 422, ['tz' => 'Choose a time zone from the list']);
        }
        if (trim((string) $tz) !== $specialist->timeZone()->getName()) {
            return $this->zoneChanged($response, $specialist);
        }

        return ['zone' => $specialist->timeZone(), 'legacy' => false];
    }

    /**
     * Re-check the zone under the doctor's slot lock (call inside the write's
     * transaction, right after `lockDoctor()`): the doctor is re-read, so a
     * zone change that committed while this request waited for the lock is
     * seen. True when the request's zone is still the doctor's.
     */
    private function zoneStillCurrent(EntityManagerInterface $em, Specialist $specialist, DateTimeZone $tz): bool
    {
        $em->refresh($specialist);

        return $specialist->timeZone()->getName() === $tz->getName();
    }

    /** 409 `timezone_changed`, carrying the doctor's current zone. */
    private function zoneChanged(ResponseInterface $response, Specialist $specialist): ResponseInterface
    {
        return $this->error($response, 'Your time zone was changed. Reload to continue.', 409, [
            'code'     => 'timezone_changed',
            'timezone' => $specialist->timeZone()->getName(),
        ]);
    }

    /** "HH:MM" (00:00–23:59) as minutes since midnight, or null when malformed. */
    private static function startMinutes(mixed $hm): ?int
    {
        if (!is_string($hm) || preg_match('/^([01]\d|2[0-3]):([0-5]\d)$/', trim($hm), $m) !== 1) {
            return null;
        }

        return ((int) $m[1]) * 60 + (int) $m[2];
    }

    /**
     * An end time as minutes since midnight. With `$midnight` (the `tz`
     * contract), "24:00" and "00:00" both mean the end of the day (1440);
     * the legacy contract keeps the strict 00:00–23:59 form.
     */
    private static function endMinutes(mixed $hm, bool $midnight): ?int
    {
        if ($midnight && is_string($hm) && in_array(trim($hm), ['24:00', '00:00'], true)) {
            return 1440;
        }

        return self::startMinutes($hm);
    }
}
