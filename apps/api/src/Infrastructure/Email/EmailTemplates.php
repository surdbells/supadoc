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
    private const CERULEAN = '#0b62e4';
    private const TEAL     = '#00796c';
    private const OCEAN    = '#0a3d80';
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
     * The doctor closed the consultation (or it was closed for them after the
     * visit). Points to the visit in the patient's history, where the summary,
     * prescriptions and documents appear. Deliberately generic: no reason for
     * the visit, diagnosis or medicine.
     *
     * @param array<string, mixed> $appt Appointment::toArray() output.
     * @return array{subject: string, html: string}
     */
    public static function consultationCompleted(array $appt, string $firstName, string $webUrl): array
    {
        $specialist = (array) ($appt['specialist'] ?? []);
        $details    = self::detailsCard([
            'Specialist' => trim(((string) ($specialist['name'] ?? '')) . self::dot((string) ($specialist['specialty'] ?? ''))),
            'Date'       => self::date((string) ($appt['scheduled_at'] ?? '')),
            'Time'       => self::time((string) ($appt['scheduled_at'] ?? '')),
        ], self::statusBadge((string) ($appt['status'] ?? ''), (string) ($appt['status_label'] ?? '')));

        $body = self::heading('Your consultation is complete')
            . self::lead('Hi ' . self::e($firstName) . ', your consultation has been completed. Anything your doctor shares with you, such as a summary, prescriptions or documents, will appear in your consultation history.')
            . $details
            . self::button('View consultation summary', $webUrl . '/dashboard/history/' . rawurlencode((string) ($appt['id'] ?? '')))
            . self::note('You can also rate your consultation there.');

        return [
            'subject' => 'Your VideoMed consultation is complete',
            'html'    => self::layout('Consultation complete', 'Your consultation has been completed.', $body),
        ];
    }

    /**
     * The doctor proposed a follow-up consultation — or, with `$reminder`, it is
     * still unanswered and closes soon. Deliberately generic: the doctor's note
     * to the patient, the reason for the visit, diagnoses and medicines never
     * appear (they are in the app). Times are pre-formatted by the caller.
     *
     * @return array{subject: string, html: string}
     */
    public static function followUpProposed(
        string $firstName,
        string $doctorName,
        string $whenLabel,
        string $replyByLabel,
        string $priceLabel,
        string $url,
        bool $reminder = false,
    ): array {
        $doctor = $doctorName !== '' ? $doctorName : 'Your doctor';
        $intro  = $reminder
            ? 'the follow-up consultation ' . $doctor . ' proposed for ' . $whenLabel . ' is still waiting for your reply. Accept it or choose another time before ' . $replyByLabel . '.'
            : $doctor . ' has proposed a follow-up consultation on ' . $whenLabel . '. Open VideoMed to accept or choose another time.';

        $body = self::heading($reminder ? 'Your follow-up is waiting for a reply' : 'Follow-up consultation proposed')
            . self::lead('Hi ' . self::e($firstName !== '' ? $firstName : 'there') . ', ' . self::e($intro))
            . self::infoCard([
                'Doctor'       => $doctor,
                'Date & time'  => $whenLabel,
                'Consultation' => 'Video follow-up',
                'Price'        => $priceLabel,
                'Reply by'     => $replyByLabel,
            ])
            . self::button('Accept or choose another time', $url)
            . self::note("If there's no reply by then, the proposal closes and the time is released. Nothing is charged until you accept.");

        return [
            'subject' => $reminder ? 'Reminder: reply to your follow-up consultation proposal' : $doctor . ' proposed a follow-up consultation',
            'html'    => self::layout(
                $reminder ? 'Follow-up reminder' : 'Follow-up proposed',
                $reminder ? 'Your proposed follow-up closes soon.' : $doctor . ' proposed a follow-up consultation.',
                $body,
            ),
        ];
    }

    /**
     * A follow-up proposal closed without becoming a booking: the doctor
     * withdrew it (`withdrawn`) or it expired unanswered (`expired`). Generic,
     * like {@see followUpProposed()}.
     *
     * @return array{subject: string, html: string}
     */
    public static function followUpClosed(string $firstName, string $doctorName, string $whenLabel, string $why, string $url): array
    {
        $doctor = $doctorName !== '' ? $doctorName : 'Your doctor';
        [$title, $intro] = match ($why) {
            'withdrawn' => [
                'Follow-up proposal withdrawn',
                $doctor . ' withdrew the follow-up consultation proposed for ' . $whenLabel . '. Nothing was charged.',
            ],
            default => [
                'Follow-up proposal closed',
                'the follow-up consultation ' . $doctor . ' proposed for ' . $whenLabel . ' closed without a reply, so the time was released. You can still book a follow-up from your consultation history.',
            ],
        };

        $body = self::heading($title)
            . self::lead('Hi ' . self::e($firstName !== '' ? $firstName : 'there') . ', ' . self::e($intro))
            . self::button('Open VideoMed', $url);

        return [
            'subject' => $title,
            'html'    => self::layout($title, $title . '.', $body),
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

    /**
     * A guest's invitation (and a re-send of it, `$resend`) with their own join
     * link, naming who invited them. Deliberately generic: never the reason
     * for the visit, a diagnosis or a medicine — only who, with whom and when.
     * Times are pre-formatted on the clinic's clock by the caller.
     *
     * @return array{subject: string, html: string}
     */
    public static function guestInvite(
        string $guestName,
        string $inviterFirstName,
        string $doctorName,
        string $whenLabel,
        string $joinUrl,
        bool $resend = false,
    ): array {
        $inviter = $inviterFirstName !== '' ? $inviterFirstName : 'A VideoMed patient';
        $doctor  = $doctorName !== '' ? $doctorName : 'their doctor';
        $intro   = $inviter . ' invited you to join their video consultation with ' . $doctor . ' on ' . $whenLabel . '.';

        $body = self::heading($resend ? 'Your invitation, again' : "You're invited to a video consultation")
            . self::lead('Hi ' . self::e($guestName !== '' ? $guestName : 'there') . ', ' . self::e($intro))
            . self::infoCard([
                'Invited by'  => $inviter,
                'Doctor'      => $doctor,
                'Date & time' => $whenLabel,
                'Join from'   => '15 minutes before the start',
            ])
            . self::button('Join the call', $joinUrl)
            . self::note("This link is personal to you — please don't forward it. Before you join you can check your camera and microphone and read the privacy notice. No account is needed.");

        return [
            'subject' => $inviter . ' invited you to a VideoMed video consultation',
            'html'    => self::layout('Video consultation invitation', $intro, $body, self::guestWhy($inviter)),
        ];
    }

    /**
     * A guest is told the consultation they were invited to moved: the new time
     * and a fresh personal link. Generic, like {@see guestInvite()}.
     *
     * @return array{subject: string, html: string}
     */
    public static function guestRescheduled(
        string $guestName,
        string $inviterFirstName,
        string $doctorName,
        string $whenLabel,
        string $joinUrl,
    ): array {
        $inviter = $inviterFirstName !== '' ? $inviterFirstName : 'A VideoMed patient';
        $doctor  = $doctorName !== '' ? $doctorName : 'their doctor';
        $intro   = 'the video consultation ' . $inviter . ' invited you to, with ' . $doctor . ', has moved to ' . $whenLabel . '.';

        $body = self::heading('New time for your video consultation')
            . self::lead('Hi ' . self::e($guestName !== '' ? $guestName : 'there') . ', ' . self::e($intro))
            . self::infoCard([
                'Invited by'  => $inviter,
                'Doctor'      => $doctor,
                'New time'    => $whenLabel,
                'Join from'   => '15 minutes before the start',
            ])
            . self::button('Join the call', $joinUrl)
            . self::note("Use this new link to join. It is personal to you — please don't forward it.");

        return [
            'subject' => 'New time: the VideoMed consultation ' . $inviter . ' invited you to',
            'html'    => self::layout('Consultation moved', 'The consultation moved to ' . $whenLabel . '.', $body, self::guestWhy($inviter)),
        ];
    }

    /**
     * A guest is told the consultation they were invited to was cancelled
     * (`cancelled`) or that they are no longer invited (`removed`); their link
     * stops working either way. Generic, like {@see guestInvite()}.
     *
     * @return array{subject: string, html: string}
     */
    public static function guestCallClosed(
        string $guestName,
        string $inviterFirstName,
        string $doctorName,
        string $whenLabel,
        string $why,
    ): array {
        $inviter = $inviterFirstName !== '' ? $inviterFirstName : 'A VideoMed patient';
        $doctor  = $doctorName !== '' ? $doctorName : 'their doctor';
        [$title, $intro] = match ($why) {
            'removed' => [
                'Invitation withdrawn',
                $inviter . ' withdrew your invitation to their video consultation with ' . $doctor . ' on ' . $whenLabel . '. Your join link no longer works.',
            ],
            default => [
                'Consultation cancelled',
                'the video consultation ' . $inviter . ' invited you to, with ' . $doctor . ' on ' . $whenLabel . ', was cancelled. Your join link no longer works.',
            ],
        };

        $body = self::heading($title)
            . self::lead('Hi ' . self::e($guestName !== '' ? $guestName : 'there') . ', ' . self::e($intro))
            . self::note("You don't need to do anything. If you have questions, ask " . $inviter . '.');

        return [
            'subject' => $why === 'removed' ? 'Your VideoMed invitation was withdrawn' : 'The VideoMed consultation you were invited to was cancelled',
            'html'    => self::layout($title, $title . '.', $body, self::guestWhy($inviter)),
        ];
    }

    /** The footer line of a guest's email (they have no account). */
    private static function guestWhy(string $inviter): string
    {
        return "You're receiving this because " . $inviter . ' invited you to a VideoMed consultation.';
    }

    /** @return array{subject: string, html: string} */
    public static function verificationCode(string $code, string $purpose): array
    {
        $intro = match ($purpose) {
            'reset'        => 'Use this code to reset your VideoMed password.',
            'change_email' => 'Use this code to confirm this is your new VideoMed email address.',
            default        => 'Use this code to verify your email and finish creating your VideoMed account.',
        };

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

    /**
     * Security notice sent to the OLD address after the account email is changed,
     * so a hijack can't happen silently.
     *
     * @return array{subject: string, html: string}
     */
    public static function emailChanged(string $firstName, string $newEmail, string $supportEmail = 'support@videomed.app'): array
    {
        $body = self::heading('Your email address was changed')
            . self::lead('Hi ' . self::e($firstName) . ', the email on your VideoMed account was just changed to '
                . '<strong style="color:' . self::INK . ';">' . self::e($newEmail) . '</strong>. '
                . 'Future sign-ins and notifications will use the new address.')
            . self::note("If you made this change, no action is needed. If you didn't, contact us immediately at " . $supportEmail . ' — this message was sent to your previous address.');

        return [
            'subject' => 'Your VideoMed email address was changed',
            'html'    => self::layout('Email changed', 'The email on your VideoMed account was changed.', $body),
        ];
    }

    /**
     * Wallet receipt — one builder for every posting (funding / consultation
     * debit / refund / adjustment), with clear transaction details.
     *
     * @param array<string, mixed> $txn WalletTransaction::toArray() output.
     * @return array{subject: string, html: string}
     */
    public static function walletReceipt(array $txn, string $firstName, string $symbol, string $webUrl): array
    {
        $type      = (string) ($txn['type'] ?? '');
        $direction = (string) ($txn['direction'] ?? '');
        $credit    = $direction === 'credit';
        $amount    = self::money($symbol, (string) ($txn['amount'] ?? '0'));
        $signed    = ($credit ? '+' : '−') . $amount;

        [$subject, $title, $intro] = match (true) {
            $credit && $type === 'topup'         => ['Your VideoMed wallet has been funded', 'Wallet funded', 'your wallet top-up was successful.'],
            $credit && $type === 'refund'        => ['Refund credited to your VideoMed wallet', 'Refund credited', 'a refund has been added to your wallet.'],
            $credit                              => ['Your VideoMed wallet was credited', 'Wallet credited', 'your wallet has been credited.'],
            !$credit && $type === 'consultation' => ['Payment received — VideoMed', 'Payment received', 'your consultation has been paid from your wallet.'],
            default                              => ['Your VideoMed wallet was debited', 'Wallet debited', 'your wallet has been debited.'],
        };

        $rows = [
            'Amount'      => $signed,
            'Transaction' => (string) ($txn['label'] ?? ucfirst($type)),
            'Reference'   => (string) ($txn['reference'] ?? ''),
            'Date'        => self::dateTime((string) ($txn['created_at'] ?? '')),
        ];
        if (($txn['description'] ?? '') !== '') {
            $rows['Details'] = (string) $txn['description'];
        }
        if (($txn['balance_after'] ?? null) !== null) {
            $rows['New balance'] = self::money($symbol, (string) $txn['balance_after']);
        }

        $body = self::heading($title)
            . self::lead('Hi ' . self::e($firstName) . ', ' . $intro)
            . self::infoCard($rows)
            . self::button('View wallet', $webUrl . '/dashboard/wallet')
            . self::note("Keep this receipt for your records. If you don't recognise this transaction, contact support right away.");

        return [
            'subject' => $subject,
            'html'    => self::layout($title, $intro, $body),
        ];
    }

    /**
     * Upcoming-consultation reminder carrying that recipient's personal join
     * link. Sent to the patient, the specialist and each guest ahead of the call.
     *
     * @param array<string, mixed> $appt Appointment::toArray() output.
     * @return array{subject: string, html: string}
     */
    public static function joinReminder(
        array $appt,
        string $recipientName,
        string $whenLabel,
        string $joinUrl,
    ): array {
        $specialist = (array) ($appt['specialist'] ?? []);
        $rows       = [
            'Specialist'   => trim(((string) ($specialist['name'] ?? '')) . self::dot((string) ($specialist['specialty'] ?? ''))),
            'Date'         => self::date((string) ($appt['scheduled_at'] ?? '')),
            'Time'         => self::time((string) ($appt['scheduled_at'] ?? '')),
            'Consultation' => (string) ($appt['type_label'] ?? 'Video consultation'),
        ];

        $body = self::heading('Your consultation is coming up')
            . self::lead('Hi ' . self::e($recipientName) . ', your video consultation is ' . self::e($whenLabel) . '. Use your personal link below to join.')
            . self::infoCard($rows)
            . self::button('Join the call', $joinUrl)
            . self::note("Your join link is personal to you — please don't forward it. Join 5–10 minutes early on a stable connection.");

        return [
            'subject' => 'Reminder: your VideoMed consultation is ' . $whenLabel,
            'html'    => self::layout('Consultation reminder', 'Your VideoMed consultation is ' . $whenLabel . '.', $body),
        ];
    }

    /** Welcome email sent once when a patient account is created. */
    public static function welcome(string $firstName, string $webUrl): array
    {
        $body = self::heading('Welcome to VideoMed')
            . self::lead('Hi ' . self::e($firstName !== '' ? $firstName : 'there')
                . ', your account is ready. You can now find a specialist, book a secure video '
                . 'consultation, and get prescriptions and follow-up care — all in one place.')
            . self::button('Find a specialist', $webUrl . '/dashboard/specialists')
            . self::note('Need help getting started? Just reply to this email or visit the help centre in your dashboard.');

        return [
            'subject' => 'Welcome to VideoMed',
            'html'    => self::layout('Welcome to VideoMed', 'Your VideoMed account is ready.', $body),
        ];
    }

    /**
     * Notify a patient that support replied to their ticket.
     *
     * @return array{subject: string, html: string}
     */
    public static function supportReply(string $firstName, string $ticketSubject, string $preview, string $webUrl): array
    {
        $body = self::heading('We replied to your request')
            . self::lead('Hi ' . self::e($firstName !== '' ? $firstName : 'there')
                . ', our support team replied to your request'
                . ($ticketSubject !== '' ? ' "<strong style="color:' . self::INK . ';">' . self::e($ticketSubject) . '</strong>"' : '') . '.')
            . ($preview !== '' ? self::infoCard(['Reply' => $preview]) : '')
            . self::button('View the conversation', $webUrl . '/dashboard/settings/help/support')
            . self::note('Reply from your support conversation in the app to keep everything in one thread.');

        return [
            'subject' => 'Re: ' . ($ticketSubject !== '' ? $ticketSubject : 'your VideoMed support request'),
            'html'    => self::layout('Support reply', 'Support replied to your VideoMed request.', $body),
        ];
    }

    /**
     * Notify a doctor of a payout status change (approved / paid / rejected).
     *
     * @return array{subject: string, html: string}
     */
    public static function payoutUpdate(string $doctorName, string $status, string $amountLabel, string $reference, string $webUrl, string $reason = ''): array
    {
        [$title, $intro] = match ($status) {
            'approved' => ['Payout approved', 'your payout request has been approved and is queued for payment.'],
            'paid'     => ['Payout paid', 'your payout has been paid out.'],
            'rejected' => ['Payout rejected', 'unfortunately your payout request was not approved.'],
            default    => ['Payout update', 'there is an update on your payout request.'],
        };

        $rows = ['Amount' => $amountLabel, 'Reference' => $reference, 'Status' => ucfirst($status)];
        if ($reason !== '') {
            $rows['Note'] = $reason;
        }

        $body = self::heading($title)
            . self::lead('Hi ' . self::e($doctorName !== '' ? $doctorName : 'Doctor') . ', ' . $intro)
            . self::infoCard($rows)
            . self::button('View payouts', $webUrl . '/payouts')
            . self::note('Payments are processed to your registered payout account. Questions? Contact the finance team.');

        return [
            'subject' => 'VideoMed payout ' . $status,
            'html'    => self::layout($title, $intro, $body),
        ];
    }

    /**
     * Notify a doctor that a patient left a review.
     *
     * @return array{subject: string, html: string}
     */
    public static function reviewReceived(string $doctorName, int $rating, string $comment, string $webUrl): array
    {
        $stars = str_repeat('★', max(0, min(5, $rating))) . str_repeat('☆', max(0, 5 - $rating));
        $rows  = ['Rating' => $stars . '  (' . $rating . '/5)'];
        if ($comment !== '') {
            $rows['Comment'] = $comment;
        }

        $body = self::heading('You received a new review')
            . self::lead('Hi ' . self::e($doctorName !== '' ? $doctorName : 'Doctor') . ', a patient just reviewed a recent consultation.')
            . self::infoCard($rows)
            . self::button('View your reviews', $webUrl . '/reviews');

        return [
            'subject' => 'New patient review on VideoMed',
            'html'    => self::layout('New review', 'A patient reviewed your consultation.', $body),
        ];
    }

    /**
     * "Dr [name] has sent your prescription [number]." Deliberately never names
     * the medicines or the reason (GVM-RX-02 AC22) — the details sit behind
     * sign-in.
     *
     * @return array{subject: string, html: string}
     */
    public static function prescriptionSent(string $firstName, string $doctorName, string $number, string $validUntil, string $url): array
    {
        $body = self::heading('Your prescription is ready')
            . self::lead('Hi ' . self::e($firstName !== '' ? $firstName : 'there') . ', '
                . self::e($doctorName) . ' has sent your prescription <strong style="color:' . self::INK . ';">' . self::e($number) . '</strong>.')
            . self::infoCard(['Prescription number' => $number, 'Valid until' => $validUntil])
            . self::button('View your prescription', $url)
            . self::note('Sign in to view, download or print it. Show it at any pharmacy — GVM does not track when your medicines are given out.');

        return [
            'subject' => $doctorName . ' has sent your prescription ' . $number,
            'html'    => self::layout('Your prescription is ready', $doctorName . ' has sent your prescription ' . $number . '.', $body),
        ];
    }

    /** @return array{subject: string, html: string} */
    public static function prescriptionCancelled(string $firstName, string $doctorName, string $number, bool $replaced, string $url): array
    {
        $body = self::heading('A prescription was cancelled')
            . self::lead('Hi ' . self::e($firstName !== '' ? $firstName : 'there') . ', '
                . self::e($doctorName) . ' has cancelled prescription <strong style="color:' . self::INK . ';">' . self::e($number) . '</strong>. '
                . 'Please do not use it at a pharmacy.'
                . ($replaced ? ' A replacement will be sent to you shortly.' : ''))
            . self::button('View your prescriptions', $url)
            . self::note('If you have questions, message your doctor from the consultation in the app.');

        return [
            'subject' => 'Prescription ' . $number . ' was cancelled',
            'html'    => self::layout('Prescription cancelled', 'Prescription ' . $number . ' was cancelled.', $body),
        ];
    }

    /** "Your prescription [number] expires on [date]. Book a consultation if you need more." */
    public static function prescriptionExpiring(string $firstName, string $number, string $expiresOn, string $url): array
    {
        $body = self::heading('Your prescription expires soon')
            . self::lead('Hi ' . self::e($firstName !== '' ? $firstName : 'there') . ', your prescription '
                . '<strong style="color:' . self::INK . ';">' . self::e($number) . '</strong> expires on '
                . self::e($expiresOn) . '. Book a consultation if you need more.')
            . self::button('Book a consultation', $url)
            . self::note('After it expires a pharmacy can no longer accept it.');

        return [
            'subject' => 'Your prescription ' . $number . ' expires on ' . $expiresOn,
            'html'    => self::layout('Prescription expiring', 'Your prescription ' . $number . ' expires on ' . $expiresOn . '.', $body),
        ];
    }

    /**
     * Invite a doctor to the portal: a one-time link to choose their password,
     * then they finish their profile and submit it for review.
     *
     * @return array{subject: string, html: string}
     */
    public static function doctorInvite(string $doctorName, string $link, int $validDays): array
    {
        $body = self::heading("You're invited to VideoMed")
            . self::lead('Hi ' . self::e($doctorName !== '' ? $doctorName : 'Doctor')
                . ', you have been invited to join VideoMed as a doctor. Choose your password to sign in, '
                . 'then complete your profile — photo, bio, qualifications, MDCN number, signature, availability '
                . 'and payout account — and submit it for review. Patients can book you once it is approved.')
            . self::button('Set your password', $link)
            . self::note('This link works once and expires in ' . $validDays . ' day' . ($validDays === 1 ? '' : 's')
                . ". If you weren't expecting this invitation, you can safely ignore this email.");

        return [
            'subject' => "You're invited to join VideoMed",
            'html'    => self::layout('Doctor invitation', 'Set your password to get started on VideoMed.', $body),
        ];
    }

    /**
     * A staff (doctor) password reset link, sent on request.
     *
     * @return array{subject: string, html: string}
     */
    public static function staffPasswordReset(string $firstName, string $link, int $validMinutes): array
    {
        $body = self::heading('Reset your password')
            . self::lead('Hi ' . self::e($firstName !== '' ? $firstName : 'there')
                . ', we received a request to reset the password for your VideoMed account. '
                . 'Use the button below to choose a new one.')
            . self::button('Choose a new password', $link)
            . self::note('This link works once and expires in ' . $validMinutes . ' minutes. '
                . "If you didn't ask to reset your password, you can ignore this email — your password won't change.");

        return [
            'subject' => 'Reset your VideoMed password',
            'html'    => self::layout('Password reset', 'Choose a new password for your VideoMed account.', $body),
        ];
    }

    /**
     * The doctor's profile passed review — they are now listed and bookable.
     *
     * @return array{subject: string, html: string}
     */
    public static function doctorApproved(string $doctorName, string $webUrl): array
    {
        $body = self::heading('Your profile is approved')
            . self::lead('Hi ' . self::e($doctorName !== '' ? $doctorName : 'Doctor')
                . ', good news — your VideoMed profile has been approved. You now appear in the doctor directory '
                . 'and patients can book consultations in the times you have made available.')
            . self::button('Open your dashboard', $webUrl . '/dashboard')
            . self::note('Keep your availability up to date so patients can always find a time that works.');

        return [
            'subject' => 'Your VideoMed profile is approved',
            'html'    => self::layout('Profile approved', 'Your VideoMed doctor profile is approved.', $body),
        ];
    }

    /**
     * The review sent the doctor's profile back, with what to change.
     *
     * @return array{subject: string, html: string}
     */
    public static function doctorRejected(string $doctorName, string $reason, string $webUrl): array
    {
        $body = self::heading('Your profile needs a few changes')
            . self::lead('Hi ' . self::e($doctorName !== '' ? $doctorName : 'Doctor')
                . ', thank you for submitting your VideoMed profile. Our team reviewed it and needs a few changes '
                . 'before it can be approved.')
            . self::infoCard(['What to update' => $reason])
            . self::button('Update your profile', $webUrl . '/onboarding')
            . self::note('Once you have made the changes, submit your profile for review again from the onboarding page.');

        return [
            'subject' => 'Your VideoMed profile needs a few changes',
            'html'    => self::layout('Profile review', 'Your VideoMed profile needs a few changes.', $body),
        ];
    }

    /**
     * To the reviewers (`specialists.manage`): a doctor submitted their profile.
     * Only the doctor's name — the profile itself is reviewed in the back office.
     * Without a back-office URL there is no button, just where to look.
     *
     * @return array{subject: string, html: string}
     */
    public static function doctorReadyForReview(string $doctorName, string $backofficeUrl): array
    {
        $name = trim($doctorName) !== '' ? trim($doctorName) : 'A doctor';
        $url  = rtrim(trim($backofficeUrl), '/');

        $body = self::heading('A doctor is ready for review')
            . self::lead(self::e($name) . ' has completed their VideoMed profile and submitted it for review. '
                . 'Check it in the back office, then approve them or send the profile back with what to change.')
            . ($url !== '' ? self::button('Review in the back office', $url . '/specialists?filter=review') : '')
            . self::note(($url !== '' ? '' : 'Open the back office, go to Specialists and choose "Needs review". ')
                . 'They are not listed or bookable until approved.');

        return [
            'subject' => 'Doctor ready for review: ' . $name,
            'html'    => self::layout('Doctor ready for review', $name . ' submitted their profile for review.', $body),
        ];
    }

    /**
     * To the reviewers (`specialists.manage`): something about a doctor needs
     * a look — changed profile details, a new licence, an automatic
     * suspension. Only the doctor's name and what happened, never the
     * documents or details themselves. `$path` is the back-office page.
     *
     * @return array{subject: string, html: string}
     */
    public static function reviewerNotice(string $headline, string $text, string $backofficeUrl, string $path): array
    {
        $url  = rtrim(trim($backofficeUrl), '/');
        $body = self::heading($headline)
            . self::lead(self::e($text))
            . ($url !== '' ? self::button('Open in the back office', $url . '/' . ltrim($path, '/')) : '')
            . self::note($url !== '' ? 'Sign in to the back office to see the details.' : 'Open the back office and go to Specialists to see the details.');

        return [
            'subject' => $headline,
            'html'    => self::layout($headline, $text, $body),
        ];
    }

    /**
     * The doctor was suspended: why, and what it means. The reason is the
     * reviewer's own words (escaped).
     *
     * @return array{subject: string, html: string}
     */
    public static function doctorSuspended(string $doctorName, string $codeLabel, string $reason, string $webUrl): array
    {
        $body = self::heading('Your VideoMed account is suspended')
            . self::lead('Hi ' . self::e($doctorName !== '' ? $doctorName : 'Doctor')
                . ', your VideoMed account has been suspended. While it is suspended you are not listed, patients cannot book you '
                . 'and you cannot do clinical work. Your upcoming bookings have been cancelled and the patients refunded.')
            . self::infoCard(['Reason' => $codeLabel, 'Details' => $reason])
            . self::button('Open your doctor portal', $webUrl . '/onboarding')
            . self::note('You can still sign in to see this, your earnings and your payout history. If your licence has expired, upload your renewed licence from the onboarding page.');

        return [
            'subject' => 'Your VideoMed account is suspended',
            'html'    => self::layout('Account suspended', 'Your VideoMed account has been suspended.', $body),
        ];
    }

    /** @return array{subject: string, html: string} */
    public static function doctorReinstated(string $doctorName, string $webUrl): array
    {
        $body = self::heading('Your VideoMed account is active again')
            . self::lead('Hi ' . self::e($doctorName !== '' ? $doctorName : 'Doctor')
                . ', your suspension has been lifted. You are listed again and patients can book you in the times you make available.')
            . self::button('Open your dashboard', $webUrl . '/dashboard')
            . self::note('Bookings cancelled while you were suspended are not restored. Check your availability is up to date.');

        return [
            'subject' => 'Your VideoMed account is active again',
            'html'    => self::layout('Account reinstated', 'Your VideoMed account is active again.', $body),
        ];
    }

    /** A reviewer turned down one of the doctor's documents, with why. @return array{subject: string, html: string} */
    public static function doctorCredentialRejected(string $doctorName, string $documentLabel, string $reason, string $webUrl): array
    {
        $body = self::heading('A document needs replacing')
            . self::lead('Hi ' . self::e($doctorName !== '' ? $doctorName : 'Doctor')
                . ', our team could not verify the document you uploaded. Please upload a new one.')
            . self::infoCard(['Document' => $documentLabel, 'Why' => $reason])
            . self::button('Upload a new document', $webUrl . '/onboarding');

        return [
            'subject' => 'Your ' . $documentLabel . ' needs replacing',
            'html'    => self::layout('Document not verified', 'A document you uploaded could not be verified.', $body),
        ];
    }

    /**
     * The doctor's practising licence expires soon (`$daysLeft` 0 = today).
     *
     * @return array{subject: string, html: string}
     */
    public static function doctorLicenceExpiring(string $doctorName, int $daysLeft, string $expiresOn, string $webUrl, int $graceDays = 0): array
    {
        $when = match (true) {
            $daysLeft <= 0 => 'today',
            $daysLeft === 1 => 'tomorrow',
            default        => 'in ' . $daysLeft . ' days',
        };
        $body = self::heading('Your practising licence expires ' . $when)
            . self::lead('Hi ' . self::e($doctorName !== '' ? $doctorName : 'Doctor')
                . ', the Annual Practising Licence on your VideoMed profile expires on <strong style="color:' . self::INK . ';">'
                . self::e($expiresOn) . '</strong>. Upload your renewed licence so our team can verify it in time.')
            . self::button('Upload your renewed licence', $webUrl . '/onboarding')
            . self::note('If no current licence has been verified by then, your account is suspended '
                . ($graceDays > 0 ? $graceDays . ' day' . ($graceDays === 1 ? '' : 's') . ' after it expires' : 'when it expires')
                . ' and your upcoming bookings are cancelled.');

        return [
            'subject' => 'Your practising licence expires ' . $when,
            'html'    => self::layout('Licence expiring', 'Your practising licence expires on ' . $expiresOn . '.', $body),
        ];
    }

    /**
     * A doctor approved before credentials existed must upload them by
     * `$dueOn`. No suspension is threatened — a reviewer decides.
     *
     * @return array{subject: string, html: string}
     */
    public static function doctorCredentialsDue(string $doctorName, int $daysLeft, string $dueOn, string $webUrl): array
    {
        $body = self::heading('Please upload your licensing documents')
            . self::lead('Hi ' . self::e($doctorName !== '' ? $doctorName : 'Doctor')
                . ', VideoMed now verifies every doctor\'s licensing documents. Please upload your MDCN full-registration certificate '
                . 'and your current Annual Practising Licence by <strong style="color:' . self::INK . ';">' . self::e($dueOn) . '</strong>'
                . ($daysLeft > 0 ? ' (' . $daysLeft . ' day' . ($daysLeft === 1 ? '' : 's') . ' from now)' : '') . '.')
            . self::button('Upload your documents', $webUrl . '/onboarding')
            . self::note('It takes a couple of minutes: a PDF or a clear photo of each document is fine.');

        return [
            'subject' => 'Please upload your licensing documents by ' . $dueOn,
            'html'    => self::layout('Documents needed', 'Upload your MDCN certificate and practising licence by ' . $dueOn . '.', $body),
        ];
    }

    /**
     * A reviewer decided on the doctor's requested profile changes (`$approved`;
     * a turned-down request carries the reason).
     *
     * @return array{subject: string, html: string}
     */
    public static function doctorChangesReviewed(string $doctorName, bool $approved, string $reason, string $webUrl): array
    {
        $title = $approved ? 'Your profile changes are approved' : 'Your profile changes were not approved';
        $body  = self::heading($title)
            . self::lead('Hi ' . self::e($doctorName !== '' ? $doctorName : 'Doctor') . ', '
                . ($approved
                    ? 'the changes you asked for on your VideoMed profile have been approved and are now live.'
                    : 'our team reviewed the changes you asked for on your VideoMed profile and could not approve them.'))
            . (!$approved && $reason !== '' ? self::infoCard(['Why' => $reason]) : '')
            . self::button('Open your profile', $webUrl . '/profile');

        return [
            'subject' => $title,
            'html'    => self::layout('Profile changes', $title . '.', $body),
        ];
    }

    /**
     * To a patient: their consultation (or a follow-up proposal) was cancelled
     * because the doctor is no longer available on VideoMed. Never says why.
     * `$refundLabel` is what went back to their wallet ('' when nothing was
     * paid); `$rebookUrl` lists doctors of the same specialty.
     *
     * @return array{subject: string, html: string}
     */
    public static function doctorUnavailableCancellation(
        string $firstName,
        string $doctorName,
        string $specialty,
        string $whenLabel,
        string $refundLabel,
        string $rebookUrl,
        bool $proposal = false,
    ): array {
        $doctor = $doctorName !== '' ? $doctorName : 'Your doctor';
        $intro  = $proposal
            ? 'the follow-up consultation ' . $doctor . ' proposed for ' . $whenLabel . ' has been withdrawn because ' . $doctor . ' is no longer available on VideoMed. Nothing was charged.'
            : 'your consultation with ' . $doctor . ' on ' . $whenLabel . ' has been cancelled because ' . $doctor . ' is no longer available on VideoMed.'
                . ($refundLabel !== '' ? ' Your payment of ' . $refundLabel . ' has been refunded to your VideoMed wallet.' : '');
        $rows = ['Doctor' => $doctor, 'Was booked for' => $whenLabel];
        if ($refundLabel !== '') {
            $rows['Refunded to your wallet'] = $refundLabel;
        }

        $body = self::heading($proposal ? 'Follow-up withdrawn' : 'Your consultation was cancelled')
            . self::lead('Hi ' . self::e($firstName !== '' ? $firstName : 'there') . ', ' . self::e($intro))
            . self::infoCard($rows)
            . self::button($specialty !== '' ? 'Find another ' . $specialty . ' specialist' : 'Find another doctor', $rebookUrl)
            . self::note('We are sorry for the inconvenience. You can book another doctor at a time that suits you.');

        return [
            'subject' => $proposal ? 'Your follow-up with ' . $doctor . ' was withdrawn' : 'Your consultation with ' . $doctor . ' was cancelled',
            'html'    => self::layout('Consultation cancelled', $doctor . ' is no longer available on VideoMed.', $body),
        ];
    }

    // ----- Building blocks -----

    private static function layout(string $title, string $preheader, string $body, ?string $why = null): string
    {
        $c   = self::CLOUD;
        $why ??= "You're receiving this because you have a VideoMed account.";

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
            . self::e($why) . '<br>'
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

    /**
     * A simple label/value card (no status row) — for receipts and reminders.
     *
     * @param array<string, string> $rows label => value (blank values skipped)
     */
    private static function infoCard(array $rows): string
    {
        $rows = array_filter($rows, static fn (string $v): bool => $v !== '');
        $html = '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ' . self::CLOUD . ';border-radius:12px;">'
            . '<tr><td style="padding:8px 22px;">'
            . '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">';

        $i    = 0;
        $last = count($rows) - 1;
        foreach ($rows as $label => $value) {
            $border = $i === $last ? '' : 'border-bottom:1px solid ' . self::CLOUD . ';';
            $html .= '<tr>'
                . '<td style="padding:10px 0;font-size:13px;color:' . self::SLATE . ';' . $border . '">' . self::e($label) . '</td>'
                . '<td align="right" style="padding:10px 0;font-size:14px;font-weight:600;color:' . self::INK . ';' . $border . '">' . self::e($value) . '</td>'
                . '</tr>';
            $i++;
        }

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
            'proposed'    => ['#fff4e5', '#a15c00'],
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

    private static function dateTime(string $iso): string
    {
        return $iso === '' ? '' : (new DateTimeImmutable($iso))->format('D, j M Y \a\t g:i A');
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
