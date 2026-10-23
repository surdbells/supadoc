<?php

declare(strict_types=1);

namespace App\Domain\Application;

use App\Domain\Contact\Countries;
use App\Domain\Contact\PhoneNumber;

/**
 * The application form's sections: their fields, rules and messages (spec
 * §2.11) — the same rules as the onboarding UI's validators.ts, both pinned by
 * fixtures/doctor-applications/validation-cases.json. Pure.
 *
 * Strings are cleaned (control characters stripped, surrounding white space
 * trimmed) before any check. `partial` (Save & continue later) skips only the
 * "required" checks: a value that is there must still be valid. Error keys are
 * field names; qualifications use `entries.{i}.{field}`.
 *
 * Two inputs the rules need from outside: the specialty list (a resolver from a
 * typed value to the list's label, or null — ReferenceDataService::resolveChoice)
 * and, for the consent signature, the applicant's first and last name.
 */
final class ApplicationSections
{
    public const SECTIONS = ['personal', 'professional', 'licence', 'qualifications', 'indemnity', 'consent'];

    /** The wording of the consent the applicant ticks (served by GET /config; spec §2.11). */
    public const CONSENT_VERSION = '2026-10';

    /** The language choices — equal to APPLICATION_LANGUAGES (application-languages.json). */
    public const LANGUAGES = [
        'English', 'Yoruba', 'Igbo', 'Hausa', 'Nigerian Pidgin', 'French',
        'Arabic', 'Portuguese', 'Spanish', 'Swahili', 'Twi', 'Other',
    ];

    public const GENDERS = ['male', 'female', 'prefer_not_to_say'];

    public const MAX_QUALIFICATIONS = 10;

    public const GOOD_STANDING_MONTHS = 6;

    public const M = [
        'first_name'             => 'Enter your first name.',
        'last_name'              => 'Enter your last name.',
        'email'                  => 'Enter a valid email address.',
        'phone'                  => 'Enter a valid phone number.',
        'date_of_birth'          => 'Enter a valid date of birth. You must be at least 21.',
        'gender'                 => 'Select an option.',
        'country_of_residence'   => 'Select your country of residence.',
        'city'                   => 'Enter your city.',
        'specialty'              => 'Choose a speciality from the list.',
        'years_experience'       => 'Enter a number from 0 to 60.',
        'workplace'              => 'Keep this under 150 characters.',
        'languages'              => 'Select at least one language.',
        'bio_short'              => 'Write at least 30 characters.',
        'bio_long'               => 'Keep your bio to 280 characters.',
        'mdcn_number'            => 'Enter your MDCN registration number (letters, numbers, / or -).',
        'full_registration_year' => 'Enter a 4-digit year, no later than this year.',
        'licence_expires_on'     => 'Expiry date must be in the future.',
        'regulator_country'      => 'Select the country of your regulator.',
        'regulator_country_ng'   => 'For a Nigerian licence, go back and choose Nigeria.',
        'regulator_name'         => "Enter your regulator's name.",
        'registration_number'    => 'Enter your licence or registration number.',
        'good_standing'          => 'Must be issued on or after %s (within the last 6 months).',
        'entries_none'           => 'Add your primary medical degree.',
        'entries_many'           => 'You can add up to 10 qualifications.',
        'degree'                 => 'Enter the degree.',
        'institution'            => 'Enter the institution.',
        'year_awarded'           => 'Enter a 4-digit year.',
        'provider'               => 'Enter your indemnity provider.',
        'policy_number'          => 'Enter the policy number.',
        'cover_expires_on'       => 'Cover expiry date must be in the future.',
        'tick'                   => 'Tick each statement to continue.',
        'signature_name'         => 'Type your full name as it appears on your application.',
    ];

    private const NAME_PATTERN = "/^[\\p{L}][\\p{L} .'\\-]*$/u";

    /**
     * Check a section's values.
     *
     * @param array<string,mixed>                $values
     * @param (callable(string):?string)|null    $resolveSpecialty the specialty list (null: any non-blank value)
     * @param array<string,mixed>                $personal         the saved personal section (consent's signature check)
     * @return array{values: array<string,mixed>, errors: array<string,string>}
     */
    public static function validate(
        string $section,
        array $values,
        string $route,
        string $todayYmd,
        bool $partial,
        ?callable $resolveSpecialty = null,
        array $personal = [],
    ): array {
        $today = self::parseYmd($todayYmd) ?? throw new \InvalidArgumentException('todayYmd must be Y-m-d');

        return match ($section) {
            'personal'       => self::personal($values, $today, $partial),
            'professional'   => self::professional($values, $partial, $resolveSpecialty),
            'licence'        => $route === 'abroad' ? self::licenceAbroad($values, $today, $partial) : self::licenceNg($values, $today, $partial),
            'qualifications' => self::qualifications($values, $today, $partial),
            'indemnity'      => self::indemnity($values, $today, $partial),
            'consent'        => self::consent($values, $partial, $personal),
            default          => throw new \InvalidArgumentException('Unknown section: ' . $section),
        };
    }

    /**
     * Whether a saved section passes the full (non-partial) rules today.
     *
     * @param array<string,mixed>|null $values
     * @param array<string,mixed>      $personal
     */
    public static function isComplete(string $section, ?array $values, string $route, string $todayYmd, ?callable $resolveSpecialty = null, array $personal = []): bool
    {
        if ($values === null) {
            return false;
        }

        return self::validate($section, $values, $route, $todayYmd, false, $resolveSpecialty, $personal)['errors'] === [];
    }

    /** The earliest acceptable Certificate of Good Standing date: 6 calendar months back, clamped to the month's end. */
    public static function goodStandingEarliest(string $todayYmd): string
    {
        $t = self::parseYmd($todayYmd) ?? throw new \InvalidArgumentException('todayYmd must be Y-m-d');
        $y = $t['y'];
        $m = $t['m'] - self::GOOD_STANDING_MONTHS;
        while ($m < 1) {
            $m += 12;
            $y--;
        }
        $d = min($t['d'], (int) (new \DateTimeImmutable(sprintf('%04d-%02d-01', $y, $m)))->format('t'));

        return sprintf('%04d-%02d-%02d', $y, $m, $d);
    }

    /** "3 March 2026" (no leading zero). */
    public static function longDate(string $ymd): string
    {
        $d = self::parseYmd($ymd);
        if ($d === null) {
            return $ymd;
        }
        $months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

        return $d['d'] . ' ' . $months[$d['m'] - 1] . ' ' . $d['y'];
    }

    /** Whether a typed email is acceptable (PHP's validator and the UI's stricter shape both agree). */
    public static function emailOk(string $email): bool
    {
        if (mb_strlen($email) > 254 || filter_var($email, FILTER_VALIDATE_EMAIL) === false) {
            return false;
        }
        $parts = explode('@', $email);
        if (count($parts) !== 2 || $parts[0] === '' || strlen($parts[0]) > 64) {
            return false;
        }
        if (preg_match("/^[a-z0-9!#$%&'*+\\/=?^_`{|}~-]+(?:\\.[a-z0-9!#$%&'*+\\/=?^_`{|}~-]+)*$/", $parts[0]) !== 1) {
            return false;
        }
        $labels = explode('.', $parts[1]);
        if (count($labels) < 2) {
            return false;
        }
        foreach ($labels as $label) {
            if (preg_match('/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/', $label) !== 1) {
                return false;
            }
        }

        return true;
    }

    /** @return array{y:int,m:int,d:int}|null */
    public static function parseYmd(mixed $s): ?array
    {
        if (!is_string($s) || preg_match('/^(\d{4})-(\d{2})-(\d{2})$/', $s, $m) !== 1) {
            return null;
        }
        [$y, $mo, $d] = [(int) $m[1], (int) $m[2], (int) $m[3]];

        return checkdate($mo, $d, $y) ? ['y' => $y, 'm' => $mo, 'd' => $d] : null;
    }

    // ----- Sections -----

    /** @param array{y:int,m:int,d:int} $today @return array{values: array<string,mixed>, errors: array<string,string>} */
    private static function personal(array $v, array $today, bool $partial): array
    {
        $e   = [];
        $out = [];
        foreach (['first_name', 'last_name'] as $k) {
            if (self::blank($v[$k] ?? null)) {
                if (!$partial) {
                    $e[$k] = self::M[$k];
                }
                continue;
            }
            $s = self::str($v[$k]);
            if ($s === null || mb_strlen($s) > 100 || preg_match(self::NAME_PATTERN, $s) !== 1) {
                $e[$k] = self::M[$k];
            }
            $out[$k] = $s;
        }

        if (self::blank($v['email'] ?? null)) {
            if (!$partial) {
                $e['email'] = self::M['email'];
            }
        } else {
            $email = mb_strtolower((string) self::str($v['email']));
            if (!self::emailOk($email)) {
                $e['email'] = self::M['email'];
            }
            $out['email'] = $email;
        }

        if (self::blank($v['phone'] ?? null)) {
            if (!$partial) {
                $e['phone'] = self::M['phone'];
            }
        } else {
            $phone = PhoneNumber::toE164((string) self::str($v['phone']));
            if ($phone === null) {
                $e['phone'] = self::M['phone'];
            }
            $out['phone'] = $phone ?? self::str($v['phone']);
        }

        if (self::blank($v['date_of_birth'] ?? null)) {
            if (!$partial) {
                $e['date_of_birth'] = self::M['date_of_birth'];
            }
        } else {
            $s   = self::str($v['date_of_birth']);
            $dob = self::parseYmd($s);
            if ($dob === null) {
                $e['date_of_birth'] = self::M['date_of_birth'];
            } else {
                $age = self::ageOn($dob, $today);
                if ($age < 21 || $age > 100) {
                    $e['date_of_birth'] = self::M['date_of_birth'];
                }
            }
            $out['date_of_birth'] = $s;
        }

        if (self::blank($v['gender'] ?? null)) {
            if (!$partial) {
                $e['gender'] = self::M['gender'];
            }
        } else {
            $s = self::str($v['gender']);
            if (!in_array($s, self::GENDERS, true)) {
                $e['gender'] = self::M['gender'];
            }
            $out['gender'] = $s;
        }

        if (self::blank($v['country_of_residence'] ?? null)) {
            if (!$partial) {
                $e['country_of_residence'] = self::M['country_of_residence'];
            }
        } else {
            $s = (string) self::str($v['country_of_residence']);
            if (!Countries::exists($s)) {
                $e['country_of_residence'] = self::M['country_of_residence'];
            }
            $out['country_of_residence'] = $s;
        }

        if (self::blank($v['city'] ?? null)) {
            if (!$partial) {
                $e['city'] = self::M['city'];
            }
        } else {
            $s = self::str($v['city']);
            if ($s === null || mb_strlen($s) > 100) {
                $e['city'] = self::M['city'];
            }
            $out['city'] = $s;
        }

        return ['values' => $out, 'errors' => $e];
    }

    /** @return array{values: array<string,mixed>, errors: array<string,string>} */
    private static function professional(array $v, bool $partial, ?callable $resolve): array
    {
        $e   = [];
        $out = [];

        if (self::blank($v['specialty'] ?? null)) {
            if (!$partial) {
                $e['specialty'] = self::M['specialty'];
            }
        } else {
            $s     = (string) self::str($v['specialty']);
            $label = $resolve !== null ? $resolve($s) : (string) preg_replace('/\s+/u', ' ', $s);
            if ($label === null || $label === '') {
                $e['specialty'] = self::M['specialty'];
            }
            $out['specialty'] = $label ?? $s;
        }

        $y = $v['years_experience'] ?? null;
        if ($y === null) {
            if (!$partial) {
                $e['years_experience'] = self::M['years_experience'];
            }
        } else {
            $n = self::intOrNull($y);
            if ($n === null || $n < 0 || $n > 60) {
                $e['years_experience'] = self::M['years_experience'];
            }
            $out['years_experience'] = $n ?? $y;
        }

        $out['workplace'] = null;
        if (!self::blank($v['workplace'] ?? null)) {
            $s = self::str($v['workplace']);
            if ($s === null || mb_strlen($s) > 150) {
                $e['workplace'] = self::M['workplace'];
            }
            $out['workplace'] = $s;
        }

        $langs = $v['languages'] ?? null;
        if (self::blank($langs)) {
            if (!$partial) {
                $e['languages'] = self::M['languages'];
            }
        } elseif (!is_array($langs) || !array_is_list($langs) || count($langs) < 1 || count($langs) > 5) {
            $e['languages'] = self::M['languages'];
        } else {
            foreach ($langs as $l) {
                if (!is_string($l) || !in_array($l, self::LANGUAGES, true)) {
                    $e['languages'] = self::M['languages'];
                    break;
                }
            }
            $out['languages'] = array_values(array_unique(array_filter($langs, 'is_string')));
        }

        if (self::blank($v['bio'] ?? null)) {
            if (!$partial) {
                $e['bio'] = self::M['bio_short'];
            }
        } else {
            $s = (string) self::str($v['bio']);
            $n = mb_strlen($s);
            if ($n < 30) {
                $e['bio'] = self::M['bio_short'];
            } elseif ($n > 280) {
                $e['bio'] = self::M['bio_long'];
            }
            $out['bio'] = $s;
        }

        return ['values' => $out, 'errors' => $e];
    }

    /** @param array{y:int,m:int,d:int} $today @return array{values: array<string,mixed>, errors: array<string,string>} */
    private static function licenceNg(array $v, array $today, bool $partial): array
    {
        $e   = [];
        $out = [];

        if (self::blank($v['mdcn_number'] ?? null)) {
            if (!$partial) {
                $e['mdcn_number'] = self::M['mdcn_number'];
            }
        } else {
            $s = mb_strtoupper((string) self::str($v['mdcn_number']));
            if (preg_match('/^[A-Z0-9\/\- ]{3,40}$/', $s) !== 1) {
                $e['mdcn_number'] = self::M['mdcn_number'];
            }
            $out['mdcn_number'] = $s;
        }

        $y = $v['full_registration_year'] ?? null;
        if ($y === null) {
            if (!$partial) {
                $e['full_registration_year'] = self::M['full_registration_year'];
            }
        } else {
            $n = self::intOrNull($y);
            if ($n === null || $n < 1960 || $n > $today['y']) {
                $e['full_registration_year'] = self::M['full_registration_year'];
            }
            $out['full_registration_year'] = $n ?? $y;
        }

        if (self::blank($v['licence_expires_on'] ?? null)) {
            if (!$partial) {
                $e['licence_expires_on'] = self::M['licence_expires_on'];
            }
        } else {
            $s = self::str($v['licence_expires_on']);
            $d = self::parseYmd($s);
            if ($d === null || self::cmp($d, $today) <= 0) {
                $e['licence_expires_on'] = self::M['licence_expires_on'];
            }
            $out['licence_expires_on'] = $s;
        }

        return ['values' => $out, 'errors' => $e];
    }

    /** @param array{y:int,m:int,d:int} $today @return array{values: array<string,mixed>, errors: array<string,string>} */
    private static function licenceAbroad(array $v, array $today, bool $partial): array
    {
        $e   = [];
        $out = [];

        if (self::blank($v['regulator_country'] ?? null)) {
            if (!$partial) {
                $e['regulator_country'] = self::M['regulator_country'];
            }
        } else {
            $s = (string) self::str($v['regulator_country']);
            if ($s === 'NG') {
                $e['regulator_country'] = self::M['regulator_country_ng'];
            } elseif (!Countries::exists($s)) {
                $e['regulator_country'] = self::M['regulator_country'];
            }
            $out['regulator_country'] = $s;
        }

        if (self::blank($v['regulator_name'] ?? null)) {
            if (!$partial) {
                $e['regulator_name'] = self::M['regulator_name'];
            }
        } else {
            $s = (string) self::str($v['regulator_name']);
            $n = mb_strlen($s);
            if ($n < 2 || $n > 150) {
                $e['regulator_name'] = self::M['regulator_name'];
            }
            $out['regulator_name'] = $s;
        }

        if (self::blank($v['registration_number'] ?? null)) {
            if (!$partial) {
                $e['registration_number'] = self::M['registration_number'];
            }
        } else {
            $s = (string) self::str($v['registration_number']);
            if (preg_match('/^[A-Za-z0-9\/\- .]{3,40}$/', $s) !== 1) {
                $e['registration_number'] = self::M['registration_number'];
            }
            $out['registration_number'] = $s;
        }

        $todayYmd = sprintf('%04d-%02d-%02d', $today['y'], $today['m'], $today['d']);
        $min      = self::goodStandingEarliest($todayYmd);
        $message  = sprintf(self::M['good_standing'], self::longDate($min));
        if (self::blank($v['good_standing_issued_on'] ?? null)) {
            if (!$partial) {
                $e['good_standing_issued_on'] = $message;
            }
        } else {
            $s = self::str($v['good_standing_issued_on']);
            $d = self::parseYmd($s);
            if ($d === null || (string) $s < $min || (string) $s > $todayYmd) {
                $e['good_standing_issued_on'] = $message;
            }
            $out['good_standing_issued_on'] = $s;
        }

        return ['values' => $out, 'errors' => $e];
    }

    /** @param array{y:int,m:int,d:int} $today @return array{values: array<string,mixed>, errors: array<string,string>} */
    private static function qualifications(array $v, array $today, bool $partial): array
    {
        $e       = [];
        $entries = $v['entries'] ?? [];
        if (!is_array($entries) || !array_is_list($entries)) {
            $entries = [];
        }
        if ($entries === [] && !$partial) {
            $e['entries'] = self::M['entries_none'];
        }
        if (count($entries) > self::MAX_QUALIFICATIONS) {
            $e['entries'] = self::M['entries_many'];
        }

        $out = [];
        foreach (array_values($entries) as $i => $entry) {
            $entry = is_array($entry) ? $entry : [];
            $row   = ['degree' => null, 'institution' => null, 'year_awarded' => null];
            foreach (['degree' => 100, 'institution' => 150] as $k => $max) {
                if (self::blank($entry[$k] ?? null)) {
                    if (!$partial) {
                        $e["entries.{$i}.{$k}"] = self::M[$k];
                    }
                    continue;
                }
                $s = self::str($entry[$k]);
                $n = $s !== null ? mb_strlen($s) : 0;
                if ($n < 2 || $n > $max) {
                    $e["entries.{$i}.{$k}"] = self::M[$k];
                }
                $row[$k] = $s;
            }
            $y = $entry['year_awarded'] ?? null;
            if ($y === null) {
                if (!$partial) {
                    $e["entries.{$i}.year_awarded"] = self::M['year_awarded'];
                }
            } else {
                $n = self::intOrNull($y);
                if ($n === null || $n < 1950 || $n > $today['y']) {
                    $e["entries.{$i}.year_awarded"] = self::M['year_awarded'];
                }
                $row['year_awarded'] = $n ?? $y;
            }
            $out[] = $row;
        }

        return ['values' => ['entries' => $out], 'errors' => $e];
    }

    /** @param array{y:int,m:int,d:int} $today @return array{values: array<string,mixed>, errors: array<string,string>} */
    private static function indemnity(array $v, array $today, bool $partial): array
    {
        $e   = [];
        $out = [];

        if (self::blank($v['provider'] ?? null)) {
            if (!$partial) {
                $e['provider'] = self::M['provider'];
            }
        } else {
            $s = (string) self::str($v['provider']);
            $n = mb_strlen($s);
            if ($n < 2 || $n > 150) {
                $e['provider'] = self::M['provider'];
            }
            $out['provider'] = $s;
        }

        if (self::blank($v['policy_number'] ?? null)) {
            if (!$partial) {
                $e['policy_number'] = self::M['policy_number'];
            }
        } else {
            $s = (string) self::str($v['policy_number']);
            if (preg_match('/^[A-Za-z0-9\/\- .]{3,60}$/', $s) !== 1) {
                $e['policy_number'] = self::M['policy_number'];
            }
            $out['policy_number'] = $s;
        }

        if (self::blank($v['cover_expires_on'] ?? null)) {
            if (!$partial) {
                $e['cover_expires_on'] = self::M['cover_expires_on'];
            }
        } else {
            $s = self::str($v['cover_expires_on']);
            $d = self::parseYmd($s);
            if ($d === null || self::cmp($d, $today) <= 0) {
                $e['cover_expires_on'] = self::M['cover_expires_on'];
            }
            $out['cover_expires_on'] = $s;
        }

        return ['values' => $out, 'errors' => $e];
    }

    /**
     * The three ticks must each be exactly `true`; the signature must hold the
     * first and last name (case, accents, spacing and order aside). The
     * consent version is checked by the caller (409 consent_outdated).
     *
     * @param array<string,mixed> $personal
     * @return array{values: array<string,mixed>, errors: array<string,string>}
     */
    private static function consent(array $v, bool $partial, array $personal): array
    {
        $e   = [];
        $out = [];
        foreach (['accept_terms', 'authorise_verification', 'confirm_accurate'] as $k) {
            $value   = $v[$k] ?? null;
            $out[$k] = $value === true;
            if ($value !== true && !($partial && ($value === null || $value === false))) {
                $e[$k] = self::M['tick'];
            }
        }

        if (self::blank($v['signature_name'] ?? null)) {
            if (!$partial) {
                $e['signature_name'] = self::M['signature_name'];
            }
        } else {
            $s     = (string) self::str($v['signature_name']);
            $f     = NameFold::fold($s);
            $first = NameFold::fold(is_string($personal['first_name'] ?? null) ? $personal['first_name'] : '');
            $last  = NameFold::fold(is_string($personal['last_name'] ?? null) ? $personal['last_name'] : '');
            $n     = mb_strlen($s);
            if ($n < 3 || $n > 200 || $first === '' || $last === '' || !str_contains($f, $first) || !str_contains($f, $last)) {
                $e['signature_name'] = self::M['signature_name'];
            }
            $out['signature_name'] = $s;
        }
        $version = $v['consent_version'] ?? null;
        if (is_string($version) && $version !== '') {
            $out['consent_version'] = $version;
        }

        return ['values' => $out, 'errors' => $e];
    }

    // ----- Helpers -----

    /** Missing: null, a string that is empty once cleaned, or an empty list. */
    public static function blank(mixed $x): bool
    {
        return $x === null
            || (is_string($x) && NameFold::clean($x) === '')
            || (is_array($x) && $x === []);
    }

    /** A scalar as cleaned text; null for anything that isn't text-like (an array, an object). */
    private static function str(mixed $x): ?string
    {
        if (is_string($x)) {
            return NameFold::clean($x);
        }
        if (is_int($x) || is_float($x)) {
            return (string) $x;
        }

        return null;
    }

    /** A whole number given as a JSON number (12, or 12.0); null for anything else ("12", 2.5, true). */
    private static function intOrNull(mixed $x): ?int
    {
        if (is_int($x)) {
            return $x;
        }
        if (is_float($x) && is_finite($x) && floor($x) === $x && abs($x) < 1e9) {
            return (int) $x;
        }

        return null;
    }

    /** @param array{y:int,m:int,d:int} $dob @param array{y:int,m:int,d:int} $today */
    private static function ageOn(array $dob, array $today): int
    {
        $age = $today['y'] - $dob['y'];
        if ($today['m'] < $dob['m'] || ($today['m'] === $dob['m'] && $today['d'] < $dob['d'])) {
            $age--;
        }

        return $age;
    }

    /** @param array{y:int,m:int,d:int} $a @param array{y:int,m:int,d:int} $b */
    private static function cmp(array $a, array $b): int
    {
        return [$a['y'], $a['m'], $a['d']] <=> [$b['y'], $b['m'], $b['d']];
    }
}
