<?php

declare(strict_types=1);

namespace App\Domain\Appointment;

use App\Domain\Entity\Appointment;
use DateTimeZone;

/**
 * Whose clock a message about a consultation is written on: the recipient's
 * zone first, and the other party's as the secondary (shown only when its
 * offset differs at that instant — see TimeZones::dual()).
 *
 *   - patient: their saved zone; secondary the doctor's ("Dr. Ada Obi's time");
 *   - doctor: their profile zone; secondary the patient's, only when the
 *     patient ever set or was detected ("your patient's time");
 *   - guest: the inviting patient's zone (a guest's own is unknown), no secondary.
 */
final class RecipientZones
{
    /** @return array{0: DateTimeZone, 1: ?DateTimeZone, 2: string} [zone, other zone, whose] */
    public static function patient(Appointment $a): array
    {
        return [$a->getPatient()->timeZone(), $a->getSpecialist()->timeZone(), self::doctorsTime($a->getSpecialist()->getName())];
    }

    /** @return array{0: DateTimeZone, 1: ?DateTimeZone, 2: string} [zone, other zone, whose] */
    public static function doctor(Appointment $a): array
    {
        return [$a->getSpecialist()->timeZone(), $a->getPatient()->knownTimeZone(), "your patient's time"];
    }

    /** @return array{0: DateTimeZone, 1: ?DateTimeZone, 2: string} [zone, other zone, whose] */
    public static function guest(Appointment $a): array
    {
        return [$a->getPatient()->timeZone(), null, ''];
    }

    /** "Dr. Ada Obi's time" (a name already ending in s gets a bare apostrophe). */
    public static function doctorsTime(string $doctorName): string
    {
        $name = trim($doctorName) !== '' ? trim($doctorName) : 'your doctor';

        return $name . (str_ends_with(strtolower($name), 's') ? "' time" : "'s time");
    }
}
