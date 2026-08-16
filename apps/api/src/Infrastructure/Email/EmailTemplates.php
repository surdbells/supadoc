<?php

declare(strict_types=1);

namespace App\Infrastructure\Email;

use DateTimeImmutable;

/**
 * Branded, responsive VideoMed transactional emails. Table-based layout with
 * inline CSS (the only combination email clients render reliably) using the
 * app's real palette — "Video" cerulean (#1565c0) / "Med" teal (#00897b).
 *
 * Each builder returns ['subject' => ..., 'html' => ...].
 */
final class EmailTemplates
{
    private const CERULEAN = '#1565c0';
    private const TEAL     = '#00897b';
    private const OCEAN    = '#0d3b6e';
    private const INK      = '#1c2b3a';
    private const SLATE    = '#546e7a';
    private const CLOUD    = '#eceff1';

    /**
     * @param array<string, mixed> $appt Appointment::toArray() output.
     * @return array{subject: string, html: string}
     */
    public static function appointmentConfirmation(array $appt, string $firstName, string $webUrl, string $currency = '₦'): array
    {
        $specialist = (array) ($appt['specialist'] ?? []);
        $details    = self::detailsCard([
            'Specialist'   => trim(((string) ($specialist['name'] ?? '')) . self::dot((string) ($specialist['specialty'] ?? ''))),
            'Date'         => self::date((string) ($appt['scheduled_at'] ?? '')),
            'Time'         => self::time((string) ($appt['scheduled_at'] ?? '')),
            'Consultation' => (string) ($appt['type_label'] ?? ''),
            'Amount'       => self::money($currency, (string) ($appt['amount'] ?? '0.00')),
        ], self::statusBadge((string) ($appt['status'] ?? ''), (string) ($appt['status_label'] ?? '')));

        $body = self::heading('Your appointment is booked')
            . self::lead('Hi ' . self::e($firstName) . ", you're all set. Here are the details of your upcoming consultation:")
            . $details
            . self::button('View appointment', $webUrl . '/dashboard/appointments/' . rawurlencode((string) ($appt['id'] ?? '')))
            . self::note('Please join 5–10 minutes early and make sure you have a stable connection.');

        return [
            'subject' => 'Your VideoMed appointment is confirmed',
            'html'    => self::layout('Appointment booked', 'Your VideoMed consultation is booked.', $body),
        ];
    }

    /**
     * @param array<string, mixed> $appt Appointment::toArray() output.
     * @return array{subject: string, html: string}
     */
    public static function appointmentStatusUpdate(array $appt, string $firstName, string $webUrl): array
    {
        $statusLabel = (string) ($appt['status_label'] ?? '');
        $specialist  = (array) ($appt['specialist'] ?? []);
        $details     = self::detailsCard([
            'Specialist' => trim(((string) ($specialist['name'] ?? '')) . self::dot((string) ($specialist['specialty'] ?? ''))),
            'Date'       => self::date((string) ($appt['scheduled_at'] ?? '')),
            'Time'       => self::time((string) ($appt['scheduled_at'] ?? '')),
        ], self::statusBadge((string) ($appt['status'] ?? ''), $statusLabel));

        $body = self::heading('Your appointment was updated')
            . self::lead('Hi ' . self::e($firstName) . ', the status of your appointment is now <strong style="color:' . self::INK . ';">' . self::e($statusLabel) . '</strong>.')
            . $details
            . self::button('View appointment', $webUrl . '/dashboard/appointments/' . rawurlencode((string) ($appt['id'] ?? '')));

        return [
            'subject' => 'Update on your VideoMed appointment',
            'html'    => self::layout('Appointment updated', 'The status of your appointment has changed.', $body),
        ];
    }

    /**
     * Multi-party session invite carrying a preauthenticated join link. Sent to
     * the patient, the specialist and each invited guest; `$recipientName` and
     * `$role` personalise the greeting and `$joinUrl` is that recipient's own
     * one-tap link into the video room.
     *
     * @param array<string, mixed> $appt      Appointment::toArray() output.
     * @param list<string>         $attendees Display names of everyone on the call.
     * @return array{subject: string, html: string}
     */
    public static function sessionInvite(
        array $appt,
        string $recipientName,
        string $role,
        string $joinUrl,
        array $attendees = [],
        string $currency = '₦',
    ): array {
        $specialist = (array) ($appt['specialist'] ?? []);
        $rows       = [
            'Specialist'   => trim(((string) ($specialist['name'] ?? '')) . self::dot((string) ($specialist['specialty'] ?? ''))),
            'Date'         => self::date((string) ($appt['scheduled_at'] ?? '')),
            'Time'         => self::time((string) ($appt['scheduled_at'] ?? '')),
            'Consultation' => (string) ($appt['type_label'] ?? 'Video consultation'),
        ];
        if ($attendees !== []) {
            $rows['Attendees'] = implode(', ', $attendees);
        }
        $details = self::detailsCard(
            $rows,
            self::statusBadge((string) ($appt['status'] ?? ''), (string) ($appt['status_label'] ?? '')),
        );

        $intro = match ($role) {
            'doctor' => 'you have a new video consultation booked. Here are the details and your link to join the call:',
            'guest'  => "you've been invited to a VideoMed video consultation. Here are the details and your link to join the call:",
            default  => "you're all set. Here are the details of your consultation and your link to join the call:",
        };

        $body = self::heading('Your video consultation')
            . self::lead('Hi ' . self::e($recipientName) . ', ' . $intro)
            . $details
            . self::button('Join the call', $joinUrl)
            . self::note("Your join link is personal to you — please don't forward it. Join 5–10 minutes early on a stable connection.");

        return [
            'subject' => 'Your VideoMed video consultation & join link',
            'html'    => self::layout('Video consultation', 'Your VideoMed consultation is booked — here is your join link.', $body),
        ];
    }

    /** @return array{subject: string, html: string} */
    public static function verificationCode(string $code, string $purpose): array
    {
        $intro = $purpose === 'reset'
            ? 'Use this code to reset your VideoMed password.'
            : 'Use this code to verify your email and finish creating your VideoMed account.';

        $body = self::heading('Your verification code')
            . self::lead($intro)
            . '<div style="margin:8px 0;text-align:center;font-size:34px;font-weight:700;'
            . 'letter-spacing:10px;color:' . self::OCEAN . ';">' . self::e($code) . '</div>'
            . self::note("This code expires in 10 minutes. If you didn't request it, you can safely ignore this email.");

        return [
            'subject' => 'Your VideoMed verification code',
            'html'    => self::layout('Verification code', 'Your VideoMed verification code', $body),
        ];
    }

    // ----- Building blocks -----

    private static function layout(string $title, string $preheader, string $body): string
    {
        $c = self::CLOUD;

        return '<!DOCTYPE html>'
            . '<html lang="en"><head><meta charset="utf-8">'
            . '<meta name="viewport" content="width=device-width,initial-scale=1">'
            . '<meta name="x-apple-disable-message-reformatting">'
            . '<title>' . self::e($title) . '</title></head>'
            . '<body style="margin:0;padding:0;background:' . $c . ';">'
            . '<span style="display:none;max-height:0;overflow:hidden;opacity:0;color:' . $c . ';">' . self::e($preheader) . '</span>'
            . '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:' . $c . ';padding:24px 12px;font-family:\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;">'
            . '<tr><td align="center">'
            . '<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:16px;overflow:hidden;">'
            . '<tr><td style="padding:26px 32px;border-bottom:1px solid ' . $c . ';">'
            . '<span style="font-size:22px;font-weight:700;letter-spacing:-0.3px;">'
            . '<span style="color:' . self::CERULEAN . ';">Video</span><span style="color:' . self::TEAL . ';">Med</span></span>'
            . '</td></tr>'
            . '<tr><td style="padding:32px;">' . $body . '</td></tr>'
            . '<tr><td style="padding:22px 32px;background:#f7f9fb;border-top:1px solid ' . $c . ';">'
            . '<p style="margin:0;font-size:12px;line-height:18px;color:' . self::SLATE . ';">'
            . "You're receiving this because you have a VideoMed account.<br>"
            . '© VideoMed — this is an automated message, please don\'t reply.</p>'
            . '</td></tr></table></td></tr></table></body></html>';
    }

    private static function heading(string $text): string
    {
        return '<h1 style="margin:0 0 10px;font-size:22px;line-height:28px;color:' . self::OCEAN . ';">' . self::e($text) . '</h1>';
    }

    private static function lead(string $html): string
    {
        return '<p style="margin:0 0 24px;font-size:15px;line-height:23px;color:' . self::SLATE . ';">' . $html . '</p>';
    }

    private static function note(string $text): string
    {
        return '<p style="margin:24px 0 0;font-size:13px;line-height:20px;color:' . self::SLATE . ';">' . self::e($text) . '</p>';
    }

    /**
     * @param array<string, string> $rows label => value
     */
    private static function detailsCard(array $rows, string $statusBadge): string
    {
        $html = '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ' . self::CLOUD . ';border-radius:12px;">'
            . '<tr><td style="padding:8px 22px;">'
            . '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">';

        foreach ($rows as $label => $value) {
            $html .= '<tr>'
                . '<td style="padding:10px 0;font-size:13px;color:' . self::SLATE . ';border-bottom:1px solid ' . self::CLOUD . ';">' . self::e($label) . '</td>'
                . '<td align="right" style="padding:10px 0;font-size:14px;font-weight:600;color:' . self::INK . ';border-bottom:1px solid ' . self::CLOUD . ';">' . self::e($value) . '</td>'
                . '</tr>';
        }

        $html .= '<tr>'
            . '<td style="padding:12px 0 10px;font-size:13px;color:' . self::SLATE . ';">Status</td>'
            . '<td align="right" style="padding:12px 0 10px;">' . $statusBadge . '</td>'
            . '</tr>';

        return $html . '</table></td></tr></table>';
    }

    private static function button(string $label, string $url): string
    {
        return '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:28px 0 0;"><tr>'
            . '<td style="border-radius:10px;background:' . self::CERULEAN . ';">'
            . '<a href="' . self::e($url) . '" style="display:inline-block;padding:13px 30px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;">' . self::e($label) . '</a>'
            . '</td></tr></table>';
    }

    private static function statusBadge(string $status, string $label): string
    {
        $palette = [
            'pending'     => ['#fff4e5', '#a15c00'],
            'confirmed'   => ['#e5f4ee', self::TEAL],
            'rescheduled' => [self::CLOUD, self::SLATE],
            'completed'   => ['#e8f1fb', self::CERULEAN],
            'cancelled'   => ['#fdecea', '#c0392b'],
        ];
        [$bg, $fg] = $palette[$status] ?? [self::CLOUD, self::SLATE];

        return '<span style="display:inline-block;padding:4px 12px;border-radius:999px;background:' . $bg . ';color:' . $fg . ';font-size:12px;font-weight:600;">' . self::e($label !== '' ? $label : ucfirst($status)) . '</span>';
    }

    private static function date(string $iso): string
    {
        return $iso === '' ? '' : (new DateTimeImmutable($iso))->format('D, j M Y');
    }

    private static function time(string $iso): string
    {
        return $iso === '' ? '' : (new DateTimeImmutable($iso))->format('g:i A');
    }

    private static function dot(string $suffix): string
    {
        return $suffix === '' ? '' : '  ·  ' . $suffix;
    }

    /** "₦45,000.00" — thousands-separated money with the configured symbol. */
    private static function money(string $currency, string $amount): string
    {
        return $currency . number_format((float) $amount, 2);
    }

    private static function e(string $value): string
    {
        return htmlspecialchars($value, ENT_QUOTES, 'UTF-8');
    }
}
