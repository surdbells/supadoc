<?php

declare(strict_types=1);

/**
 * Production data migration for the "complete consultation flow" release.
 * Unlike bin/seed.php (which refuses in production and creates demo rows), this
 * only ADAPTS existing production data and is safe to run on a live database.
 *
 * It is fully idempotent — re-running it changes nothing that's already done:
 *   1. Ensures the pricing settings exist (currency=NGN, guest_fee, platform_fee)
 *      — only fills a key that is missing, never overwrites a back-office value.
 *   2. Converts each specialist's consultation fee from the old USD era to Naira
 *      (×100), but ONLY while it still looks like a dollar-era value (< 1000), so
 *      it never touches a fee you've already set in Naira.
 *   3. Gives every specialist a contact email if it has none (a derived
 *      placeholder — update these to the doctors' real inboxes so invites land).
 *   4. Creates one doctor login per specialist (role `doctor`, linked via
 *      specialist_id). New logins get a password (from DOCTOR_DEFAULT_PASSWORD if
 *      set, else a random one PRINTED once below). Existing users are never
 *      re-passworded, and a non-doctor account that happens to share an email is
 *      left untouched (reported as a conflict).
 *
 * Usage (on the server, inside apps/api):
 *   php bin/prod-migrate.php --run
 *   DOCTOR_DEFAULT_PASSWORD='S3tByYou!' php bin/prod-migrate.php --run
 *
 * Doctors can also join calls via their emailed preauthenticated link without
 * ever logging in — the portal login is a convenience on top of that.
 */

use App\Domain\Entity\AppSetting;
use App\Domain\Entity\Specialist;
use App\Domain\Entity\User;
use App\Infrastructure\Persistence\DoctrineEntityManagerFactory;

require __DIR__ . '/../vendor/autoload.php';

Dotenv\Dotenv::createImmutable(__DIR__ . '/..')->safeLoad();

if (!in_array('--run', $argv, true)) {
    fwrite(STDOUT, "This adapts LIVE data. Re-run with --run to proceed:\n  php bin/prod-migrate.php --run\n");
    exit(0);
}

$em = DoctrineEntityManagerFactory::create();

/** Strip an honorific and split "Dr. Grace Bell" into [first, last]. */
function nameParts(string $name): array
{
    $clean = trim(preg_replace('/^(dr|prof|mr|mrs|ms)\.?\s+/i', '', $name) ?? $name);
    $parts = preg_split('/\s+/', $clean) ?: [$clean];

    return [$parts[0] ?? $clean, count($parts) > 1 ? implode(' ', array_slice($parts, 1)) : 'Doctor'];
}

/** A stable placeholder email from a specialist's name, e.g. grace.bell@videomed.test. */
function slugEmail(string $name): string
{
    [$first, $last] = nameParts($name);
    $slug = strtolower(trim($first . '.' . $last));
    $slug = preg_replace('/[^a-z0-9.]+/', '', $slug) ?? 'doctor';

    return ($slug !== '' ? $slug : 'doctor') . '@videomed.test';
}

$report = [
    'settings_seeded'   => [],
    'fees_migrated'     => 0,
    'emails_set'        => 0,
    'doctors_created'   => 0,
    'doctors_updated'   => 0,
    'email_conflicts'   => [],
    'new_logins'        => [],
];

// 1) Pricing settings — fill only what's missing (defaults mirror PricingService).
$defaults = ['currency' => 'NGN', 'guest_fee' => '5000', 'platform_fee' => '200'];
foreach ($defaults as $key => $value) {
    if ($em->getRepository(AppSetting::class)->find($key) === null) {
        $em->persist(new AppSetting($key, $value));
        $report['settings_seeded'][] = $key;
    }
}

$defaultPassword = trim((string) ($_ENV['DOCTOR_DEFAULT_PASSWORD'] ?? ''));

// 2) Specialists: Naira fees + contact email + doctor login.
foreach ($em->getRepository(Specialist::class)->findAll() as $specialist) {
    // Fee: convert USD-era values to Naira once (×100). Skip anything already ≥1000.
    if ((float) $specialist->getConsultationFee() < 1000) {
        $naira = number_format((float) $specialist->getConsultationFee() * 100, 2, '.', '');
        $specialist->setConsultationFee($naira);
        $report['fees_migrated']++;
    }

    if ($specialist->getEmail() === null) {
        $specialist->setEmail(slugEmail($specialist->getName()));
        $report['emails_set']++;
    }
    $em->persist($specialist);

    $email = (string) $specialist->getEmail();
    $user  = $em->getRepository(User::class)->findOneBy(['email' => strtolower($email)]);

    if ($user !== null && !in_array('doctor', $user->getRoles(), true)) {
        // An existing non-doctor (e.g. admin) shares this email — never clobber it.
        $report['email_conflicts'][] = $email;
        continue;
    }

    if ($user === null) {
        [$first, $last] = nameParts($specialist->getName());
        $user     = new User($email, $first, $last);
        $password = $defaultPassword !== '' ? $defaultPassword : bin2hex(random_bytes(6));
        $user->setPassword($password);
        $report['doctors_created']++;
        $report['new_logins'][] = ['email' => $email, 'password' => $password];
    } else {
        $report['doctors_updated']++;
    }

    $user->setRoles(['doctor']);
    $user->setPermissions(['appointments.view']);
    $user->setSpecialistId($specialist->getId());
    $em->persist($user);
}

$em->flush();

fwrite(STDOUT, json_encode($report, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n");
fwrite(STDOUT, "\nDone. Reminder: the doctor emails above are placeholders — update each\n");
fwrite(STDOUT, "specialist's email to the doctor's real inbox so invites + join links land there.\n");
