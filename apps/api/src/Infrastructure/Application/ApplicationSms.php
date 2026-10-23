<?php

declare(strict_types=1);

namespace App\Infrastructure\Application;

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
        'interview'    => 'VideoMed: interview for {ref} on {when} WAT. Joining details are in your email.',
        'approved'     => 'VideoMed: application {ref} is approved. Check your email to set your password.',
        'rejected'     => 'VideoMed: there\'s an update on application {ref}. Please check your email.',
        'withdrawn'    => 'VideoMed: application {ref} has been withdrawn as you asked.',
        'track_code'   => 'VideoMed: your code is {code}. It expires in 10 minutes. Don\'t share it.',
    ];

    /** @param array<string,string> $vars ref, host, when ("Wed 14 Oct, 10:00"), code */
    public static function text(string $key, array $vars): string
    {
        $template = self::TEXTS[$key] ?? throw new \InvalidArgumentException('Unknown SMS: ' . $key);
        $replace  = [];
        foreach (['ref', 'host', 'when', 'code'] as $name) {
            $replace['{' . $name . '}'] = self::gsm((string) ($vars[$name] ?? ''));
        }

        return mb_substr(strtr($template, $replace), 0, 160);
    }

    /** "Wed 14 Oct, 10:00" in the clinic's zone. */
    public static function when(\DateTimeImmutable $at, \DateTimeZone $zone): string
    {
        return $at->setTimezone($zone)->format('D j M, H:i');
    }

    /** Only the GSM-7 basic characters our texts use: letters, digits, space and . , : - / ' . */
    private static function gsm(string $s): string
    {
        return (string) preg_replace('/[^A-Za-z0-9 .,:\/\'\-]/', '', $s);
    }
}
