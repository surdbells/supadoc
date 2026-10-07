<?php

declare(strict_types=1);

/**
 * Send due appointment join reminders (and prescription expiry housekeeping). Meant to be run by cron every few minutes
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
