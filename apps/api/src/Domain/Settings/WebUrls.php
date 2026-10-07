<?php

declare(strict_types=1);

namespace App\Domain\Settings;

use App\Domain\Entity\Patient;
use App\Domain\Entity\Specialist;
use App\Domain\Entity\User;

/**
 * Which web app a link should point at. One API serves several front-end
 * deployments (e.g. patient.dosthq.com and patient.betacrest.com for different
 * test groups), so every emailed / notified / printed link follows the person:
 * each user's site is remembered when they sign in, and their links use it.
 *
 * Configuration (comma-separated origins, the FIRST is the default):
 *   PATIENT_WEB_URLS=https://patient.dosthq.com,https://patient.betacrest.com
 *   STAFF_WEB_URLS=https://doctor.dosthq.com,https://doctor.betacrest.com
 * Lists are paired by position, so a doctor on the 2nd staff site gets the 2nd
 * patient site for patient-app links (e.g. call join links). Without the lists
 * the single APP_WEB_URL / STAFF_WEB_URL values are used.
 */
final class WebUrls
{
    /** @var list<string> */
    private static array $patient = [];
    /** @var list<string> */
    private static array $staff = [];
    private static string $requestOrigin = '';

    /**
     * @param list<string> $patientUrls
     * @param list<string> $staffUrls
     */
    public static function configure(array $patientUrls, array $staffUrls): void
    {
        self::$patient = self::clean($patientUrls) ?: ['http://localhost:4201'];
        self::$staff   = self::clean($staffUrls) ?: ['http://localhost:4204'];
    }

    /** Build the lists from the environment (see class doc). */
    public static function configureFromEnv(array $env): void
    {
        $list = static fn (string $key): array => array_values(array_filter(array_map('trim', explode(',', (string) ($env[$key] ?? '')))));
        $patient = $list('PATIENT_WEB_URLS') ?: $list('APP_WEB_URL');
        $staff   = $list('STAFF_WEB_URLS') ?: ($list('STAFF_WEB_URL') ?: $list('APP_WEB_URL'));
        self::configure($patient, $staff);
    }

    /** The Origin header of the request being served (set once per request). */
    public static function setRequestOrigin(string $origin): void
    {
        self::$requestOrigin = $origin;
    }

    public static function patientDefault(): string
    {
        return self::$patient[0] ?? 'http://localhost:4201';
    }

    public static function staffDefault(): string
    {
        return self::$staff[0] ?? 'http://localhost:4204';
    }

    /** `$origin` if it is a configured patient site, else null. */
    public static function matchPatient(?string $origin): ?string
    {
        $o = self::normalise($origin);

        return in_array($o, self::$patient, true) ? $o : null;
    }

    /** `$origin` if it is a configured staff site, else null. */
    public static function matchStaff(?string $origin): ?string
    {
        $o = self::normalise($origin);

        return in_array($o, self::$staff, true) ? $o : null;
    }

    /** The patient site the current request came from, if it is one. */
    public static function requestPatientOrigin(): ?string
    {
        return self::matchPatient(self::$requestOrigin);
    }

    /** The staff site the current request came from, if it is one. */
    public static function requestStaffOrigin(): ?string
    {
        return self::matchStaff(self::$requestOrigin);
    }

    /** Base URL for links sent to this patient (their site, else the default). */
    public static function forPatient(?Patient $patient): string
    {
        return self::matchPatient($patient?->getWebOrigin()) ?? self::patientDefault();
    }

    /** Base URL for links to the staff portal sent to this user. */
    public static function forStaff(?User $user): string
    {
        return self::matchStaff($user?->getWebOrigin()) ?? self::staffDefault();
    }

    /**
     * Base URL of the PATIENT app that pairs with a staff site (same position in
     * the lists) — for patient-app links given to staff, e.g. call join links.
     */
    public static function patientAppForStaffOrigin(?string $staffOrigin): string
    {
        $i = array_search(self::normalise($staffOrigin), self::$staff, true);

        return $i !== false && isset(self::$patient[$i]) ? self::$patient[$i] : self::patientDefault();
    }

    /** {@see patientAppForStaffOrigin()} for a staff user's remembered site. */
    public static function patientAppForStaff(?User $user): string
    {
        return self::patientAppForStaffOrigin($user?->getWebOrigin());
    }

    /** Base URL of the doctor portal for links sent to this doctor. */
    public static function forSpecialist(?Specialist $doctor): string
    {
        return self::matchStaff($doctor?->getWebOrigin()) ?? self::staffDefault();
    }

    /** Base URL of the patient app paired with this doctor's portal (call join links). */
    public static function patientAppForSpecialist(?Specialist $doctor): string
    {
        return self::patientAppForStaffOrigin($doctor?->getWebOrigin());
    }

    /** @param list<string> $urls @return list<string> */
    private static function clean(array $urls): array
    {
        return array_values(array_unique(array_filter(array_map([self::class, 'normalise'], $urls))));
    }

    private static function normalise(?string $origin): string
    {
        return strtolower(rtrim(trim((string) $origin), '/'));
    }
}
