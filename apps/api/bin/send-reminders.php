<?php

declare(strict_types=1);

/**
 * Send due appointment join reminders (plus prescription expiry housekeeping,
 * closing past consultations nobody closed — completed, never confirmed or
 * missed (PastAppointmentCloser) — expiring / nudging unanswered
 * follow-up proposals, doctors' licence reminders / expiry, and reconciling
 * card payments: re-checking unconfirmed ones with Paystack and crediting
 * unused ones to the patient's wallet). Meant to be
 * run by cron every few minutes
 * (more often than the ReminderService catch-up window, e.g. every 5 minutes):
 *
 *   * / 5 * * * *  cd /path/to/apps/api && php bin/send-reminders.php >> var/log/reminders.log 2>&1
 *
 * Offsets are configured with REMINDER_OFFSETS (comma-separated minutes-before,
 * default "1440,60"). Each (appointment, offset) reminder is sent exactly once.
 */

use App\Infrastructure\Persistence\SettingsRegistry;
use App\Infrastructure\Service\PastAppointmentCloser;
use App\Infrastructure\Service\ReminderService;
use App\Infrastructure\Service\SettingsCacheService;
use DI\Container;
use DI\ContainerBuilder;
use Doctrine\ORM\EntityManagerInterface;

require __DIR__ . '/../vendor/autoload.php';

Dotenv\Dotenv::createImmutable(__DIR__ . '/..')->safeLoad();

// A fresh container — and with it a fresh entity manager once the last one
// was closed by a failure (DoctrineEntityManagerFactory reuses one only while open).
$build = static function (): Container {
    $builder = new ContainerBuilder();
    $builder->addDefinitions(__DIR__ . '/../config/container.php');
    $container = $builder->build();

    // Static handle for code that can't take DI (mirrors public/index.php).
    SettingsRegistry::set($container->get(SettingsCacheService::class));

    return $container;
};
$container = $build();

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

// Past consultations nobody closed (PastAppointmentCloser; the windows are
// Booking settings): a visit whose slot ended over missed_after_hours (12)
// ago with proof it happened (a note, prescription, certificate, referral,
// lab order, the doctor's words on the transcript, or both sides on the call
// at the same time) is marked completed — confirmed or not; a request the
// doctor never confirmed is cancelled once its slot ended (+
// unconfirmed_expiry_minutes_after_end) and refunded in full; a confirmed
// visit with no proof is marked missed (who didn't come from each side's
// presence) and refunded by the no-show rules. Visits that started over 3
// days ago close quietly. A closed visit is never picked again and every
// refund posts under a fixed reference, so running every 5 minutes is safe.
// A failure that closes the entity manager (any exception inside a row's
// transaction) would stop the rest of the run, and the next run would meet the
// same row first: so the run is repeated on a fresh container, skipping the
// visits that failed, at most PastAppointmentCloser::RETRIES times.
try {
    $past = PastAppointmentCloser::runWithRetries(static function (array $skipIds, int $attempt) use (&$container, $build): array {
        if ($attempt > 0) {
            $container = $build();
        }
        $result = $container->get(PastAppointmentCloser::class)->run(null, $skipIds);

        return [$result, $container->get(EntityManagerInterface::class)->isOpen()];
    });
    $kinds = [];
    foreach ($past['kinds'] as $kind => $count) {
        $kinds[] = $kind . '=' . $count;
    }
    printf(
        "[%s] consultations: auto_completed=%d quiet=%d evidence=%s expired_unconfirmed=%d missed=doctor:%d,patient:%d,both:%d ambiguous=%d closed_quietly=%d refunded=%s alerts=%d errors=%d failed=%s retries=%d\n",
        gmdate('Y-m-d H:i:s'),
        $past['completed'],
        $past['completed_quiet'],
        $kinds !== [] ? implode(',', $kinds) : '-',
        $past['expired'],
        $past['missed']['doctor'],
        $past['missed']['patient'],
        $past['missed']['both'],
        $past['ambiguous'],
        $past['quiet'],
        $past['refunded'],
        $past['alerts'],
        $past['errors'],
        $past['failed_ids'] !== [] ? implode(',', $past['failed_ids']) : '-',
        $past['retries'],
    );
} catch (\Throwable $e) {
    fwrite(STDERR, '[' . gmdate('Y-m-d H:i:s') . '] consultations: ' . $e->getMessage() . "\n");
}

// The jobs below need a usable entity manager: if the last attempt above
// still left it closed, start them on a fresh one.
try {
    if (!$container->get(EntityManagerInterface::class)->isOpen()) {
        $container = $build();
    }
} catch (\Throwable $e) {
    fwrite(STDERR, '[' . gmdate('Y-m-d H:i:s') . '] container: ' . $e->getMessage() . "\n");
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

// Doctors' practising licences: a reminder at each of LICENCE_REMINDER_DAYS
// (default 30,14,7,1) before one expires; once it has expired (plus
// LICENCE_GRACE_DAYS, default 0) a doctor with no other current licence is
// suspended automatically — their bookings cancelled and refunded. Doctors
// approved before documents existed get 30 days from the first run to upload
// them, with reminders (never an automatic suspension). Each stage is
// recorded before its email goes, so running every 5 minutes is safe.
try {
    $lic = $container->get(App\Infrastructure\Service\CredentialExpiryService::class)->run();
    printf(
        "[%s] licences: reminders=%d expired=%d suspended=%d incomplete=%d legacy_due_set=%d legacy_reminders=%d\n",
        gmdate('Y-m-d H:i:s'),
        $lic['licence_reminders'],
        $lic['licences_expired'],
        $lic['suspended'],
        $lic['suspensions_incomplete'],
        $lic['legacy_due_set'],
        $lic['legacy_reminders'],
    );
} catch (\Throwable $e) {
    fwrite(STDERR, '[' . gmdate('Y-m-d H:i:s') . '] licences: ' . $e->getMessage() . "\n");
}

// Card payments (PaymentIntentService::sweep): a checkout started over 15
// minutes ago that never confirmed is re-checked with Paystack (so a charge
// whose webhook never arrived is still found; unpaid after a day it expires),
// and a paid one nothing used for CARD_INTENT_CREDIT_AFTER_MINUTES (default 30)
// is credited to the patient's wallet — they get an in-app notice and the
// wallet receipt. Each credit is decided under the payment's row lock and posts
// under a fixed reference, so running every 5 minutes (or alongside a booking
// using the same payment) never pays twice. A failure that closes the entity
// manager re-runs the pass on a fresh container, skipping what failed; a
// payment that fails goes to the back of its queue (so failures can't starve
// the rest), and one that can never be credited automatically is held for
// review (held_for_review=N; see DEPLOY.md "Card payments to review").
try {
    $cards = App\Infrastructure\Service\PaymentIntentService::sweepWithRetries(static function (array $skip, int $attempt) use (&$container, $build): array {
        if ($attempt > 0 || !$container->get(EntityManagerInterface::class)->isOpen()) {
            $container = $build();
        }

        return $container->get(App\Infrastructure\Service\PaymentIntentService::class)->sweep(null, $skip);
    });
    printf(
        "[%s] card payments: reverified=%d paid=%d expired=%d credited=%d credited_total=%s held_for_review=%d errors=%d failed=%s retries=%d\n",
        gmdate('Y-m-d H:i:s'),
        $cards['reverified'],
        $cards['paid'],
        $cards['expired'],
        $cards['credited'],
        $cards['credited_total'],
        $cards['review'] ?? 0,
        $cards['errors'],
        $cards['failed_refs'] !== [] ? implode(',', $cards['failed_refs']) : '-',
        $cards['retries'],
    );
} catch (\Throwable $e) {
    fwrite(STDERR, '[' . gmdate('Y-m-d H:i:s') . '] card payments: ' . $e->getMessage() . "\n");
}
