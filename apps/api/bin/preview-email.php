<?php

declare(strict_types=1);

/**
 * Render the branded transactional emails to HTML files so you can eyeball them
 * without sending anything. Writes to var/email-preview/ and prints the paths.
 *
 *   php bin/preview-email.php
 */

use App\Infrastructure\Email\EmailTemplates;

require __DIR__ . '/../vendor/autoload.php';

$sampleAppointment = [
    'id'           => '00000000-0000-0000-0000-000000000000',
    'specialist'   => ['name' => 'Dr. Grace Bell', 'specialty' => 'Cardiology'],
    'scheduled_at' => '2026-09-01T10:00:00+00:00',
    'type_label'   => 'Video Consultation',
    'status'       => 'confirmed',
    'status_label' => 'Confirmed',
    'amount'       => '150.00',
];

$webUrl  = $_ENV['APP_WEB_URL'] ?? 'http://localhost:4201';
$outDir  = __DIR__ . '/../var/email-preview';
@mkdir($outDir, 0777, true);

$samples = [
    'appointment-confirmation' => EmailTemplates::appointmentConfirmation($sampleAppointment, 'Pat', $webUrl),
    'appointment-status-update' => EmailTemplates::appointmentStatusUpdate(
        ['status' => 'cancelled', 'status_label' => 'Cancelled'] + $sampleAppointment,
        'Pat',
        $webUrl,
    ),
    'guest-invite'      => EmailTemplates::guestInvite('Bola', 'Pat', 'Dr. Grace Bell', 'Tue 1 Sep, 11:00 AM WAT', $webUrl . '/call/join/sample'),
    'guest-rescheduled' => EmailTemplates::guestRescheduled('Bola', 'Pat', 'Dr. Grace Bell', 'Wed 2 Sep, 9:00 AM WAT', $webUrl . '/call/join/sample'),
    'guest-cancelled'   => EmailTemplates::guestCallClosed('Bola', 'Pat', 'Dr. Grace Bell', 'Tue 1 Sep, 11:00 AM WAT', 'cancelled'),
    'guest-removed'     => EmailTemplates::guestCallClosed('Bola', 'Pat', 'Dr. Grace Bell', 'Tue 1 Sep, 11:00 AM WAT', 'removed'),
    // Names the doctor only — never the note, a document, a specialty or a reason.
    'document-access-requested' => EmailTemplates::documentAccessRequested('Pat', 'Dr. Grace Bell', $webUrl . '/dashboard/documents?request=00000000-0000-0000-0000-000000000000'),

    // Doctor applications (apps/onboarding; spec §5.2).
    'application-saved'          => EmailTemplates::applicationSaved('Ada', 'http://localhost:4205/resume#t=sample', 'K7Q2MX', 7, 30),
    'application-code-confirm'   => EmailTemplates::applicationCode('482913', 'confirm_email'),
    'application-code-track'     => EmailTemplates::applicationCode('482913', 'track'),
    'application-submitted'      => EmailTemplates::applicationSubmitted('Ada', 'GVM-DR-2026-48213', 'http://localhost:4205/?dialog=track'),
    'application-under-review'   => EmailTemplates::applicationUnderReview('Ada', 'GVM-DR-2026-48213', 'http://localhost:4205/?dialog=track'),
    'application-info-requested' => EmailTemplates::applicationInfoRequested('Ada', 'GVM-DR-2026-48213', "Your practising licence scan is cut off.\nPlease upload the whole page.", ['Current MDCN practising licence', 'Licence'], 'http://localhost:4205/?dialog=track', 'Wed, 14 Oct 2026 at 10:00 AM WAT'),
    'application-info-received'  => EmailTemplates::applicationInfoReceived('Ada', 'GVM-DR-2026-48213'),
    'application-interview'      => EmailTemplates::applicationInterview('Ada', 'GVM-DR-2026-48213', '2026-10-14T10:00:00+01:00', 30, 'https://meet.google.com/abc-defg-hij', 'Please have your ID ready.', false),
    'application-interview-moved' => EmailTemplates::applicationInterview('Ada', 'GVM-DR-2026-48213', '2026-10-15T11:30:00+01:00', 30, 'https://meet.google.com/abc-defg-hij', null, true),
    'application-approved'       => EmailTemplates::applicationApproved('Ada', 'Obi', 'GVM-DR-2026-48213', 'http://localhost:4204/auth/set-password?token=sample', 7),
    'application-rejected'       => EmailTemplates::applicationRejected('Ada', 'GVM-DR-2026-48213', 'We could not verify your practising licence with MDCN.', 'support@videomed.app'),
    'application-withdrawn'      => EmailTemplates::applicationWithdrawn('Ada', 'GVM-DR-2026-48213'),
    'application-reviewer-new'   => EmailTemplates::reviewerNotice('New doctor application: Ada Obi', 'Ada Obi submitted application GVM-DR-2026-48213.', 'http://localhost:4202', '/applications/00000000-0000-0000-0000-000000000000'),
];

foreach ($samples as $name => $mail) {
    $path = $outDir . '/' . $name . '.html';
    file_put_contents($path, $mail['html']);
    fwrite(STDOUT, $mail['subject'] . "\n  -> " . realpath($path) . "\n");
}
