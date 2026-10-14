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
 *      left untouched (reported as a conflict). Doctors still in onboarding are
 *      skipped — they get their login from the back-office invite.
 *   5. Vitals history: copies each sent prescription's readings into
 *      vital_readings as the prescribing doctor's (once per prescription; needs
 *      the schema update first).
 *   6. Doctor onboarding: marks every pre-existing doctor (status NULL) as
 *      approved, so the new review step never hides a live doctor.
 *
 * Before step 0 writes anything it checks that this release's schema update has
 * been applied (tables + columns), and stops with instructions if not — so a
 * missing column can never stop the run part-way. Any later stop still prints
 * the report collected so far, so a new doctor login's password is never lost.
 *
 * Usage (on the server, inside apps/api):
 *   php bin/prod-migrate.php --run
 *   DOCTOR_DEFAULT_PASSWORD='S3tByYou!' php bin/prod-migrate.php --run
 *
 * Doctors can also join calls via their emailed preauthenticated link without
 * ever logging in — the portal login is a convenience on top of that.
 */

use App\Domain\Entity\AppSetting;
use App\Domain\Entity\Patient;
use App\Domain\Entity\Prescription;
use App\Domain\Entity\Specialist;
use App\Domain\Entity\User;
use App\Domain\Entity\VitalReading;
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

/** The run's report as JSON — printed at the end, and on every early stop. */
function printReport(array $report): void
{
    fwrite(STDOUT, json_encode($report, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n");
}

/**
 * Stop with a message, printing the report collected so far first: a doctor
 * login created in step 2 has its password ONLY in that report, and a re-run
 * never sets a new one, so no exit may skip it.
 */
function bail(array $report, string $message): never
{
    printReport($report);
    fwrite(STDERR, "\n" . $message);
    exit(1);
}

$report = [
    'completed_steps'   => [],
    'settings_seeded'   => [],
    'admins_granted'    => 0,
    'fees_migrated'     => 0,
    'emails_set'        => 0,
    'doctors_created'   => 0,
    'doctors_updated'   => 0,
    'passwords_reset'   => [],
    'email_conflicts'   => [],
    'new_logins'        => [],
];

// Anything that stops the run part-way (a database error, say) still prints
// what was already saved — above all the new doctor logins' passwords.
set_exception_handler(static function (\Throwable $e) use (&$report): void {
    bail($report, sprintf(
        "Stopped part-way: %s: %s\n"
        . "The steps in completed_steps were saved, and so were any new_logins listed above — keep those\n"
        . "passwords, they are not shown again. Fix the cause and re-run; finished work is skipped.\n",
        $e::class,
        $e->getMessage(),
    ));
});

// Check this release's schema BEFORE anything is written. Steps 0 and 2 load
// users and specialists through Doctrine, which selects every mapped column,
// and steps 3, 5 and 6 need this release's tables and columns — so a missing
// schema update would otherwise stop the run part-way, after earlier steps had
// saved (and after step 2 had created doctor logins).
$conn     = $em->getConnection();
$schema   = $conn->createSchemaManager();
$unquote  = static fn (string $name): string => strtolower(trim($name, '"`[]'));
$tables   = array_map($unquote, $schema->listTableNames());
$required = [
    'prescriptions'  => ['valid_until'],          // step 3 (e-prescribing)
    'vital_readings' => [],                       // step 5 (vitals history)
    'specialists'    => ['status'],               // step 6 (doctor onboarding)
    'users'          => ['password_token_hash'],  // doctor invite / reset links
];
// …and every column the entities used below map, so no Doctrine load or write
// can fail on a column the schema update has not added yet.
foreach ([User::class, Specialist::class, AppSetting::class, Patient::class, Prescription::class, VitalReading::class] as $class) {
    $meta             = $em->getClassMetadata($class);
    $table            = $unquote($meta->getTableName());
    $required[$table] = array_merge($required[$table] ?? [], array_map($unquote, $meta->getColumnNames()));
}
$missingSchema = [];
foreach ($required as $table => $wanted) {
    if (!in_array($table, $tables, true)) {
        $missingSchema[] = "table {$table}";
        continue;
    }
    $have = array_map($unquote, array_keys($schema->listTableColumns($table)));
    foreach (array_unique(array_diff($wanted, $have)) as $column) {
        $missingSchema[] = "{$table}.{$column}";
    }
}
if ($missingSchema !== []) {
    bail($report, "This release's schema update has not been applied — missing: " . implode(', ', $missingSchema) . ".\n"
        . "Nothing has been changed. Clear the Doctrine cache, apply the schema, then re-run this script:\n"
        . "  rm -rf var/cache/doctrine*\n"
        . "  php bin/doctrine.php orm:schema-tool:update --dump-sql   # review\n"
        . "  php bin/doctrine.php orm:schema-tool:update --force\n"
        . "  php bin/prod-migrate.php --run\n");
}

// 0) Grant the back-office permissions the new endpoints require to any admin,
//    so pricing + specialist edits work without a reseed. Idempotent merge.
$backOfficePerms = ['settings.manage', 'specialists.manage', 'monitoring.view'];
foreach ($em->getRepository(User::class)->findAll() as $user) {
    if (!in_array('admin', $user->getRoles(), true)) {
        continue;
    }
    $missing = array_diff($backOfficePerms, $user->getPermissions());
    if ($missing !== []) {
        $user->setPermissions([...$user->getPermissions(), ...$missing]);
        $em->persist($user);
        $report['admins_granted']++;
    }
}

// 1) Pricing settings — fill only what's missing (defaults mirror PricingService).
$defaults = ['currency' => 'NGN', 'guest_fee' => '5000', 'platform_fee' => '200'];
foreach ($defaults as $key => $value) {
    if ($em->getRepository(AppSetting::class)->find($key) === null) {
        $em->persist(new AppSetting($key, $value));
        $report['settings_seeded'][] = $key;
    }
}

// Read from getenv() first — a `VAR=x php …` prefix lands there, whereas $_ENV
// is only populated when PHP's variables_order includes 'E'. When set, it's also
// applied to EXISTING doctor logins so you can rotate them all to one password.
$envPassword     = getenv('DOCTOR_DEFAULT_PASSWORD');
$defaultPassword = trim((string) ($envPassword !== false ? $envPassword : ($_ENV['DOCTOR_DEFAULT_PASSWORD'] ?? '')));

// 2) Specialists: Naira fees + contact email + doctor login.
$pendingLogins = []; // reported once saved — a failed flush never lists logins that don't exist
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

    // A doctor still in onboarding gets their login from the back-office invite
    // (they choose their own password) — never a printed one from here.
    if (!$specialist->isApproved()) {
        continue;
    }

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
        $pendingLogins[] = ['email' => $email, 'password' => $password];
    } else {
        // Existing doctor login: rotate to the shared password if one was given
        // (safe — only touches doctor accounts, never admin/other staff).
        if ($defaultPassword !== '') {
            $user->setPassword($defaultPassword);
            $report['passwords_reset'][] = $email;
        }
        $report['doctors_updated']++;
    }

    $user->setRoles(['doctor']);
    $user->setPermissions(['appointments.view']);
    $user->setSpecialistId($specialist->getId());
    $em->persist($user);
}

$em->flush();
$report['new_logins']      = $pendingLogins;
$report['completed_steps'] = [0, 1, 2];

// 3) E-prescribing release: bring prescriptions issued on the old free-text form
//    into the numbered, statused model — a GVM-RX number (dated by when it was
//    written), the prescriber, `active` instead of `signed`, and a valid-until
//    30 days after issue. Only fills what is missing; safe to re-run. (Its
//    columns were checked at the top.)
$report['prescriptions_backfilled'] = 0;
$legacy = $conn->fetchAllAssociative(
    "SELECT p.id, p.appointment_id, p.created_at, p.signed_at, p.status, p.valid_until, p.number, p.specialist_id, a.specialist_id AS appt_specialist
       FROM prescriptions p LEFT JOIN appointments a ON a.id = p.appointment_id
      WHERE p.number IS NULL OR p.status = 'signed' OR p.valid_until IS NULL OR p.specialist_id IS NULL
      ORDER BY p.created_at ASC",
);
foreach ($legacy as $row) {
    $issued  = new DateTimeImmutable((string) ($row['signed_at'] ?? $row['created_at']));
    $updates = [];
    if ($row['number'] === null) {
        $updates['number'] = (new App\Infrastructure\Prescription\PrescriptionNumberGenerator($conn))->next($issued);
    }
    if ($row['status'] === 'signed') {
        $updates['status'] = 'active';
    }
    if ($row['valid_until'] === null) {
        $updates['valid_until'] = $issued->modify('+30 days')->format('Y-m-d');
    }
    if ($row['specialist_id'] === null && $row['appt_specialist'] !== null) {
        $updates['specialist_id'] = $row['appt_specialist'];
    }
    if ($updates !== []) {
        $conn->update('prescriptions', $updates, ['id' => $row['id']]);
        $report['prescriptions_backfilled']++;
    }
}
$report['completed_steps'][] = 3;

// 4) Canonical allergy severities: the old patient form saved Low / Medium /
//    High; the doctor's prescribing panel ranks life-threatening > severe >
//    moderate > mild > unknown. Re-normalising maps the legacy wording (and
//    leaves anything unrecognised exactly as the patient typed it). Idempotent.
$report['allergy_severities_normalised'] = 0;
foreach ($em->getRepository(Patient::class)->findAll() as $patient) {
    $before = $patient->getMedical();
    if (($before['allergies'] ?? []) === []) {
        continue;
    }
    $patient->setMedical($before);
    if ($patient->getMedical() !== $before) {
        $report['allergy_severities_normalised']++;
    }
}
$em->flush();
$report['completed_steps'][] = 4;

// 5) Vitals history: readings on sent prescriptions were only kept as each
//    patient's latest-per-type cache. Copy every sent prescription's readings
//    into vital_readings, as the prescribing doctor's — once per prescription
//    (one that already has rows is skipped), so it is safe to re-run. Each
//    prescription's rows go in one transaction, so a stop part-way never leaves
//    one half-copied (and then skipped for good). The table was checked at the top.
$report['vital_readings_backfilled'] = 0;
$serverZone = new DateTimeZone(date_default_timezone_get());
$sentRx     = $conn->fetchAllAssociative(
    "SELECT p.id, p.patient_id, p.specialist_id, p.appointment_id, p.readings, p.sent_at, p.signed_at, p.created_at
       FROM prescriptions p
      WHERE p.status <> 'draft' AND p.readings IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM vital_readings v WHERE v.prescription_id = p.id)",
);
foreach ($sentRx as $row) {
    $readings = json_decode((string) $row['readings'], true);
    if (!is_array($readings)) {
        continue;
    }
    try {
        $takenAt = new DateTimeImmutable((string) ($readings['taken_at'] ?? $row['sent_at'] ?? $row['signed_at'] ?? $row['created_at']));
    } catch (\Throwable) {
        continue;
    }
    $takenAt = $takenAt->setTimezone($serverZone)->format('Y-m-d H:i:s');
    $source   = is_string($readings['source'] ?? null) && $readings['source'] !== '' ? $readings['source'] : 'video';
    $inserted = 0;
    $conn->beginTransaction();
    try {
        foreach (App\Infrastructure\Vitals\VitalsForm::READINGS as $key => [, $unit]) {
            $value = trim((string) (is_scalar($readings[$key] ?? null) ? $readings[$key] : ''));
            if ($value === '') {
                continue;
            }
            $conn->insert('vital_readings', [
                'id'               => Ramsey\Uuid\Uuid::uuid4()->toString(),
                'patient_id'       => $row['patient_id'],
                'reading_key'      => $key,
                'value'            => mb_substr($value, 0, 20),
                'unit'             => $unit,
                'taken_at'         => $takenAt,
                'source'           => mb_substr($source, 0, 20),
                'recorded_by_type' => 'doctor',
                'recorded_by_id'   => $row['specialist_id'],
                'appointment_id'   => $row['appointment_id'],
                'prescription_id'  => $row['id'],
                'created_at'       => (new DateTimeImmutable())->format('Y-m-d H:i:s'),
            ]);
            $inserted++;
        }
        $conn->commit();
    } catch (\Throwable $e) {
        $conn->rollBack();
        throw $e;
    }
    $report['vital_readings_backfilled'] += $inserted;
}
$report['completed_steps'][] = 5;

// 6) Doctor onboarding: every doctor who existed before the review step is
//    already live, so record them as approved (the app also reads a NULL status
//    as approved, so nothing is hidden before this runs). Only NULLs are
//    touched — doctors invited since, or already reviewed, keep their status.
//    (The column was checked at the top.)
$report['specialists_marked_approved'] = (int) $conn->executeStatement(
    "UPDATE specialists SET status = 'approved' WHERE status IS NULL",
);
$report['completed_steps'][] = 6;

printReport($report);
fwrite(STDOUT, "\nDone. Reminder: the doctor emails above are placeholders — update each\n");
fwrite(STDOUT, "specialist's email to the doctor's real inbox so invites + join links land there.\n");
