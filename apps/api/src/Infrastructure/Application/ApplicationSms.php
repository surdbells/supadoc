<?php

declare(strict_types=1);

namespace App\Infrastructure\Application;

use App\Domain\Settings\TimeZones;
use DateTimeImmutable;
use DateTimeZone;

/**
 * The applicant's text messages (spec §5.3). Pure. GSM-7 only (no curly quotes
 * or dashes), at most 160 characters, never a name or a clinical / document
 * detail; the only link is our own onboarding host.
 */
final class ApplicationSms
{
    public const TEXTS = [
        'submitted'    => 'VideoMed: we received your doctor application {ref}. We\'ll email and text you when its status changes.',
        'under_review' => 'VideoMed: application {ref} is now under review. No action needed.',
        'more_info'    => 'VideoMed: we need more information for application {ref}. Check your email or {host} to respond.',
        'interview'    => 'VideoMed: interview for {ref} on {when}. Joining details are in your email.',
        'approved'     => 'VideoMed: application {ref} is approved. Check your email to set your password.',
        'rejected'     => 'VideoMed: there\'s an update on application {ref}. Please check your email.',
        'withdrawn'    => 'VideoMed: application {ref} has been withdrawn as you asked.',
        'track_code'   => 'VideoMed: your code is {code}. It expires in 10 minutes. Don\'t share it.',
    ];

    /** @param array<string,string> $vars ref, host, when ("Wed 14 Oct, 04:00 CDT (10:00 WAT)"), code */
    public static function text(string $key, array $vars): string
    {
        $template = self::TEXTS[$key] ?? throw new \InvalidArgumentException('Unknown SMS: ' . $key);
        $replace  = [];
        foreach (['ref', 'host', 'when', 'code'] as $name) {
            $replace['{' . $name . '}'] = self::gsm((string) ($vars[$name] ?? ''));
        }

        return mb_substr(strtr($template, $replace), 0, 160);
    }

    /**
     * "Wed 14 Oct, 10:00 WAT" in the applicant's zone (24-hour), plus the
     * clinic's time when its offset differs: "Wed 14 Oct, 04:00 CDT (10:00 WAT)"
     * — with the clinic's weekday when its date differs.
     */
    public static function when(DateTimeImmutable $at, DateTimeZone $zone, ?DateTimeZone $clinic = null): string
    {
        $local = $at->setTimezone($zone);
        $text  = TimeZones::DAYS[(int) $local->format('w')] . ' ' . $local->format('j') . ' '
            . TimeZones::MONTHS[(int) $local->format('n') - 1] . ', ' . $local->format('H:i') . ' ' . TimeZones::abbr($at, $zone);
        if ($clinic === null || !TimeZones::offsetsDiffer($at, $zone, $clinic)) {
            return $text;
        }
        $there = $at->setTimezone($clinic);
        $day   = $there->format('Y-m-d') !== $local->format('Y-m-d') ? TimeZones::DAYS[(int) $there->format('w')] . ' ' : '';

        return $text . ' (' . $day . $there->format('H:i') . ' ' . TimeZones::abbr($at, $clinic) . ')';
    }

    /** Only the GSM-7 basic characters our texts use: letters, digits, space and . , : - / ' ( ) + . */
    private static function gsm(string $s): string
    {
        return (string) preg_replace('/[^A-Za-z0-9 .,:\/\'()+\-]/', '', $s);
    }
}
