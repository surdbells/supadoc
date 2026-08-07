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
];

foreach ($samples as $name => $mail) {
    $path = $outDir . '/' . $name . '.html';
    file_put_contents($path, $mail['html']);
    fwrite(STDOUT, $mail['subject'] . "\n  -> " . realpath($path) . "\n");
}
