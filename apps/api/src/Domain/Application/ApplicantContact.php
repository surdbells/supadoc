<?php

declare(strict_types=1);

namespace App\Domain\Application;

use App\Domain\Contact\PhoneNumber;

/**
 * How an applicant's contact details are shown back to them (spec §3.1 masks,
 * D25): only ever a mask of what they typed themselves, or a generic phrase —
 * the track lookup never reveals whether anything matched.
 */
final class ApplicantContact
{
    public const GENERIC_PHONE = 'The phone number on your application';
    public const GENERIC_EMAIL = 'The email address on your application';

    /** "cle***@gmail.com": the first 3 characters of the local part (fewer if shorter). */
    public static function maskEmail(string $email): string
    {
        $email = strtolower(trim($email));
        $at    = strrpos($email, '@');
        if ($at === false) {
            return '***';
        }
        $local = substr($email, 0, $at);

        return mb_substr($local, 0, min(3, mb_strlen($local))) . '***@' . substr($email, $at + 1);
    }

    /**
     * Nigerian: "0802*****56" (0 + the first three national digits, the last two).
     * Other: "+44 77*****23" (code, the first two national digits, the last two).
     */
    public static function maskPhone(string $e164): string
    {
        [$cc, $national] = PhoneNumber::split($e164);
        if ($cc === '234') {
            return '0' . substr($national, 0, 3) . '*****' . substr($national, -2);
        }

        return '+' . $cc . ' ' . substr($national, 0, 2) . '*****' . substr($national, -2);
    }

    /** Whether what was typed into "email or phone" is an email address (otherwise it is read as a phone). */
    public static function looksLikeEmail(string $contact): bool
    {
        return str_contains($contact, '@');
    }
}
