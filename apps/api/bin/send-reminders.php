<?php

declare(strict_types=1);

/**
 * Send due appointment join reminders (plus prescription expiry housekeeping,
 * closing consultations a doctor forgot to end, and expiring / nudging
 * unanswered follow-up proposals). Meant to be run by cron every few minutes
 * (more often than the ReminderService catch-up window, e.g. every 5 minutes):
 *
 *   * / 5 * * * *  cd /path/to/apps/api && php bin/send-reminders.php >> var/log/reminders.log 2>&1
 *
 * Offsets are configured with REMINDER_OFFSETS (comma-separated minutes-before,
 * default "1440,60"). Each (appointment, offset) reminder is sent exactly once.
 */

use App\Infrastructure\Persistence\SettingsRegistry;
use App\Infrastructure\Service\ReminderService;
use App\Infrastructure\Service\SettingsCacheService;
use DI\ContainerBuilder;

require __DIR__ . '/../vendor/autoload.php';

Dotenv\Dotenv::createImmutable(__DIR__ . '/..')->safeLoad();

$builder = new ContainerBuilder();
$builder->addDefinitions(__DIR__ . '/../config/container.php');
$container = $builder->build();

// Static handle for code that can't take DI (mirrors public/index.php).
SettingsRegistry::set($container->get(SettingsCacheService::class));

$reminders = $container->get(ReminderService::class);
$result    = $reminders->run();

printf(
    "[%s] reminders: offsets=%s sent=%d recipients=%d\n",
    gmdate('Y-m-d H:i:s'),
    implode(',', $result['offsets']),
    $result['reminders_sent'],
    $result['recipients'],
);

// Prescription housekeeping: store expiries + send "expires in N days" reminders
// (each prescription is reminded once, so running every 5 minutes is safe).
try {
    $rx = $container->get(App\Infrastructure\Prescription\PrescriptionExpiryService::class)->run();
    printf("[%s] prescriptions: expired=%d expiry_reminders=%d\n", gmdate('Y-m-d H:i:s'), $rx['expired'], $rx['reminded']);
} catch (\Throwable $e) {
    fwrite(STDERR, '[' . gmdate('Y-m-d H:i:s') . '] prescriptions: ' . $e->getMessage() . "\n");
}

// Consultations the doctor forgot to end: confirmed visits whose slot ended over
// 12 hours ago and that have proof they happened (a note, prescription,
// certificate, referral, lab order, the doctor's words on the transcript, or both
// sides on the call at the same time) are marked completed. No proof (e.g. a
// no-show, or a patient who waited alone) → left alone. A completed visit is
// never picked again, so running every 5 minutes is safe.
try {
    $done = $container->get(App\Infrastructure\Service\ConsultationCompleter::class)->autoCompleteOverdue();
    $kinds = [];
    foreach ($done['kinds'] as $kind => $count) {
        $kinds[] = $kind . '=' . $count;
    }
    printf(
        "[%s] consultations: auto_completed=%d quiet=%d evidence=%s\n",
        gmdate('Y-m-d H:i:s'),
        $done['completed'],
        $done['quiet'],
        $kinds !== [] ? implode(',', $kinds) : '-',
    );
} catch (\Throwable $e) {
    fwrite(STDERR, '[' . gmdate('Y-m-d H:i:s') . '] consultations: ' . $e->getMessage() . "\n");
}

// Follow-up proposals the patient hasn't answered: past their expiry (2 hours
// before the slot, at most 72 hours after proposing) they are cancelled and
// both sides told; about a day before that the patient is reminded once. An
// expired proposal is never picked again and the reminder is recorded before
// it is sent, so running every 5 minutes is safe.
try {
    $fu = $container->get(App\Infrastructure\Service\FollowUpService::class)->housekeeping();
    printf("[%s] follow-ups: expired=%d nudged=%d\n", gmdate('Y-m-d H:i:s'), $fu['expired'], $fu['nudged']);
} catch (\Throwable $e) {
    fwrite(STDERR, '[' . gmdate('Y-m-d H:i:s') . '] follow-ups: ' . $e->getMessage() . "\n");
}
