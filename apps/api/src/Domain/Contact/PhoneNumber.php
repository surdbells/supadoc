<?php

declare(strict_types=1);

namespace App\Domain\Contact;

/**
 * Phone numbers as E.164 ("+2348031234567") — what applications store and
 * Termii sends to (without the "+"). Pure (spec §3.1):
 *  - spaces, "-", ".", "(" and ")" are ignored;
 *  - "+" or "00" then 8–15 digits is international ("+234 0803…" drops the
 *    Nigerian trunk 0);
 *  - "0" + 10 digits, or 10 digits starting 7, 8 or 9, is Nigerian;
 *  - a Nigerian number must have exactly 10 national digits.
 */
final class PhoneNumber
{
    public static function toE164(string $raw, string $defaultCc = '234'): ?string
    {
        $s = (string) preg_replace('/[\s\-.()]/u', '', $raw);
        if (preg_match('/^(?:\+|00)(\d{8,15})$/', $s, $m) === 1) {
            $digits = $m[1];
            if (str_starts_with($digits, '2340')) {
                $digits = '234' . substr($digits, 4);
            }
            if (str_starts_with($digits, '234') && strlen($digits) - 3 !== 10) {
                return null;
            }

            return '+' . $digits;
        }
        if (preg_match('/^0(\d{10})$/', $s, $m) === 1) {
            return '+' . $defaultCc . $m[1];
        }
        if (preg_match('/^[789]\d{9}$/', $s) === 1) {
            return '+' . $defaultCc . $s;
        }

        return null;
    }

    /** Termii's `to`: the E.164 digits without the "+". */
    public static function termiiTo(string $e164): string
    {
        return ltrim($e164, '+');
    }

    /**
     * [calling code, national number] of an E.164 number, by the longest known
     * code that prefixes it ("+447700900123" → ['44', '7700900123']).
     *
     * @return array{0:string, 1:string}
     */
    public static function split(string $e164): array
    {
        $digits = ltrim($e164, '+');
        foreach (Countries::dialCodes() as $code) {
            if (str_starts_with($digits, $code) && strlen($digits) > strlen($code)) {
                return [$code, substr($digits, strlen($code))];
            }
        }

        return ['', $digits];
    }
}
