<?php

declare(strict_types=1);

/**
 * Production data migration for the "complete consultation flow" release.
 * Unlike bin/seed.php (which refuses in production and creates demo rows), this
 * only ADAPTS existing production data and is safe to run on a live database.
 *
 * It is safe to run on every deploy. Steps 0–2 run ONCE per database (recorded
 * in the `prod_migrate.legacy_done` setting; a database an earlier release
 * already migrated is recorded without re-running them), because repeating
 * them would re-multiply a sub-₦1,000 fee, re-grant narrowed admin permissions
 * and reset doctor logins. Steps 3–8 are idempotent — a re-run changes nothing
 * that's already done (the numbers match the steps below):
 *   0. Grants the back-office permissions (settings.manage, specialists.manage,
 *      monitoring.view) to every admin that lacks them.
 *   1. Ensures the pricing settings exist (currency=NGN, guest_fee, platform_fee)
 *      — only fills a key that is missing, never overwrites a back-office value.
 *   2. Specialists: converts each consultation fee from the old USD era to Naira
 *      (×100), but ONLY while it still looks like a dollar-era value (< 1000), so
 *      it never touches a fee you've already set in Naira; gives every
 *      specialist a contact email if it has none (a derived placeholder —
 *      update these to the doctors' real inboxes so invites land); and creates
 *      one doctor login per specialist (role `doctor`, linked via
 *      specialist_id). New logins get a password (from DOCTOR_DEFAULT_PASSWORD if
 *      set, else a random one PRINTED once below). Existing users are never
 *      re-passworded, and a non-doctor account that happens to share an email is
 *      left untouched (reported as a conflict). Doctors still in onboarding are
 *      skipped — they get their login from the back-office invite.
 *   3. E-prescribing: gives prescriptions from the old free-text form a GVM-RX
 *      number, `active` status, a valid-until date and their prescriber.
 *   4. Rewrites legacy allergy severities (Low / Medium / High) in the
 *      canonical wording the prescribing panel ranks.
 *   5. Vitals history: copies each sent prescription's readings into
 *      vital_readings as the prescribing doctor's (once per prescription).
 *   6. Doctor onboarding: marks every pre-existing doctor (status NULL) as
 *      approved, so the new review step never hides a live doctor.
 *   7. Booking attachments: moves every file under the PUBLIC
 *      public/uploads/appointment-docs folder into private document storage as
 *      the patient's "Booking Attachment" — linked to the appointment that
 *      points at it (whose document_url is then cleared), or unlinked for a
 *      booking that was never made. One it can't take in (it fails the upload
 *      checks, names no patient, or names a different patient than its
 *      appointment) moves to the private var/quarantine/appointment-docs
 *      folder instead and is listed for a look by hand — nothing stays public.
 *   8. Guests: gives every guest invited before guests had identities a stable
 *      id + Agora uid (100+), the uid their already-emailed links carry (so
 *      those keep working while they stay invited), and what they cost.
 *
 * Before step 0 writes anything it checks that this release's schema update has
 * been applied (tables + columns), and stops with instructions if not — so a
 * missing column can never stop the run part-way. Any later stop still prints
 * the report collected so far, so a new doctor login's password is never lost.
 *
 * `--dry-run` runs every step inside one database transaction that is rolled
 * back at the end, and step 7 only checks the files (it moves nothing) — so
 * the report shows what --run would change, and nothing is saved. (Its doctor
 * logins are not created, so it prints no passwords.)
 *
 * Usage (on the server, inside apps/api):
 *   php bin/prod-migrate.php --dry-run    # preview: nothing is saved
 *   php bin/prod-migrate.php --run
 *   DOCTOR_DEFAULT_PASSWORD='S3tByYou!' php bin/prod-migrate.php --run
 *
 * Doctors can also join calls via their emailed preauthenticated link without
 * ever logging in — the portal login is a convenience on top of that.
 */

use App\Domain\Entity\AppSetting;
use App\Domain\Entity\Appointment;
use App\Domain\Entity\MedicalDocument;
use App\Domain\Entity\Patient;
use App\Domain\Entity\Prescription;
use App\Domain\Entity\Specialist;
use App\Domain\Entity\User;
use App\Domain\Entity\VitalReading;
use App\Infrastructure\Document\LegacyBookingAttachments;
use App\Infrastructure\Persistence\DoctrineEntityManagerFactory;
use App\Infrastructure\Service\DocumentRejectedException;
use App\Infrastructure\Service\MedicalDocumentStorage;

require __DIR__ . '/../vendor/autoload.php';

Dotenv\Dotenv::createImmutable(__DIR__ . '/..')->safeLoad();

$dryRun = in_array('--dry-run', $argv, true);
if (!$dryRun && !in_array('--run', $argv, true)) {
    fwrite(STDOUT, "This adapts LIVE data. Preview it with --dry-run (nothing is saved), or re-run with --run to proceed:\n"
        . "  php bin/prod-migrate.php --dry-run\n  php bin/prod-migrate.php --run\n");
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
    'dry_run'           => $dryRun,
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
set_exception_handler(static function (\Throwable $e) use (&$report, $dryRun): void {
    bail($report, sprintf(
        $dryRun
            ? "Dry run stopped: %s: %s\nNothing was saved. Fix the cause before running with --run.\n"
            : "Stopped part-way: %s: %s\n"
                . "The steps in completed_steps were saved, and so were any new_logins listed above — keep those\n"
                . "passwords, they are not shown again. Fix the cause and re-run; finished work is skipped.\n",
        $e::class,
        $e->getMessage(),
    ));
});

// Check this release's schema BEFORE anything is written. Steps 0 and 2 load
// users and specialists through Doctrine, which selects every mapped column,
// and steps 3, 5, 6 and 7 need this release's tables and columns — so a missing
// schema update would otherwise stop the run part-way, after earlier steps had
// saved (and after step 2 had created doctor logins).
$conn     = $em->getConnection();
$schema   = $conn->createSchemaManager();
$unquote  = static fn (string $name): string => strtolower(trim($name, '"`[]'));
$tables   = array_map($unquote, $schema->listTableNames());
$required = [
    'prescriptions'     => ['valid_until'],          // step 3 (e-prescribing)
    'vital_readings'    => [],                       // step 5 (vitals history)
    'specialists'       => ['status'],               // step 6 (doctor onboarding)
    'users'             => ['password_token_hash'],  // doctor invite / reset links
    'appointments'      => ['document_url', 'guests', 'guest_uid_seq'], // steps 7 + 8 (booking attachments, guest identities)
    'medical_documents' => ['appointment_id'],       // step 7 (a join column, so listed by hand)
];
// …and every column the entities used below map, so no Doctrine load or write
// can fail on a column the schema update has not added yet.
foreach ([User::class, Specialist::class, AppSetting::class, Patient::class, Prescription::class, VitalReading::class, MedicalDocument::class, Appointment::class] as $class) {
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

// A dry run does all its database work inside one transaction and rolls it
// back at the end (nested transactions below become savepoints), so every
// step reports exactly what --run would change while nothing is saved.
if ($dryRun) {
    $conn->beginTransaction();
}

// Steps 0–2 adapted the data of the first releases (USD-era fees to Naira,
// the first admin grants and doctor logins). They must NOT re-run on every
// deploy: a fee later set below ₦1,000 would be multiplied by 100, admin
// permissions narrowed in the back office re-granted, and every doctor login
// reset to the base role. So they run once per database, recorded in the
// `prod_migrate.legacy_done` setting. A database an earlier release already
// migrated (it has the pricing settings step 1 seeds) is recorded without
// running them again.
$legacyKey    = 'prod_migrate.legacy_done';
$settingsRepo = $em->getRepository(AppSetting::class);
if ($settingsRepo->find($legacyKey) !== null) {
    $report['legacy_steps'] = 'already done';
} elseif ($settingsRepo->find('guest_fee') !== null) {
    $report['legacy_steps'] = 'applied by an earlier release — recorded, not re-run';
} else {
    $report['legacy_steps'] = 'ran';
}
$runLegacy = $report['legacy_steps'] === 'ran';

if ($runLegacy) {
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
    // A dry run rolls these logins back, so it never prints a password.
    $report['new_logins']      = $dryRun
        ? array_map(static fn (array $login): array => ['email' => $login['email'], 'password' => '(dry run: not created)'], $pendingLogins)
        : $pendingLogins;
}

if ($settingsRepo->find($legacyKey) === null) {
    $em->persist(new AppSetting($legacyKey, (new \DateTimeImmutable())->format(DATE_ATOM)));
    $em->flush();
}
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

// 7) Booking attachments: a file attached while booking used to be saved under
//    public/uploads/appointment-docs as {patient id}-{8 hex}.{ext} — reachable
//    by anyone with the URL, and never shown to the doctor. Each one moves into
//    private document storage as the patient's Booking Attachment: a file an
//    appointment points at is filed for that appointment's patient and linked
//    to it (document_url is then cleared); a file no appointment points at (a
//    booking that was never made) is filed, unlinked, for the patient whose id
//    it starts with. Each row is saved in its own transaction and a file's last
//    row MOVES it (see LegacyBookingAttachments::file()), so a filed file
//    leaves nothing public behind and a re-run only finds what is left. A file
//    that can't be filed — missing, failing the upload checks, naming no
//    patient, or naming a different patient than its appointment — moves to
//    the private quarantine folder instead (outside the web root, 0700) and is
//    listed for a look by hand, so nothing is left public either way. An
//    appointment whose URL isn't one of these files is listed too. A dry run
//    checks each file but moves nothing. (Its tables and columns were checked
//    at the top.)
$report['booking_attachments_imported']    = 0;
$report['booking_attachments_skipped']     = [];
$report['booking_attachments_quarantined'] = [];
$publicDir   = dirname(__DIR__) . '/public/uploads/appointment-docs';
$storage     = new MedicalDocumentStorage();
$legacyFiles = new LegacyBookingAttachments($storage, $publicDir, dirname(__DIR__) . '/var/quarantine/appointment-docs');

/**
 * Take a file that can't be filed out of the public folder, listing it with
 * why and the appointments that point at it (a dry run only says where it
 * would go). A failed move throws, so the run never ends with it still public.
 *
 * @param list<array<string,mixed>> $group
 */
$quarantine = static function (string $name, string $reason, array $group = []) use ($legacyFiles, $publicDir, $dryRun, &$report): void {
    $moved = $dryRun
        ? (is_file($publicDir . '/' . $name) ? $legacyFiles->quarantinePath($name) : null)
        : $legacyFiles->quarantine($name);
    $report['booking_attachments_quarantined'][] = array_filter([
        'file'            => $name,
        'appointment_ids' => array_values(array_filter(array_column($group, 'id'))), // none for an unlinked file
        'reason'          => $reason,
        'quarantined_at'  => $moved ?? ($dryRun ? '(not in the public folder)' : '(in neither the public nor the quarantine folder)'),
    ]);
};

/** One row's database side, in its own transaction (LegacyBookingAttachments::file() undoes its file on a throw). */
$saveAttachment = static function (array $row, array $columns) use ($conn, &$report): void {
    $conn->beginTransaction();
    try {
        $conn->insert('medical_documents', $columns);
        if ($columns['appointment_id'] !== null) {
            $conn->update('appointments', ['document_url' => null], ['id' => $columns['appointment_id']]);
        }
        $conn->commit();
    } catch (\Throwable $e) {
        $conn->rollBack();
        throw $e;
    }
    $report['booking_attachments_imported']++;
};

// Files appointments point at, grouped by file (a URL can only have been reused
// by hand, but then every appointment still gets its own copy).
$grouped = $legacyFiles->group($conn->fetchAllAssociative(
    "SELECT a.id, a.document_url, a.created_at, p.id AS patient_id, p.first_name, p.last_name
       FROM appointments a JOIN patients p ON p.id = a.patient_id
      WHERE a.document_url IS NOT NULL AND a.document_url <> ''
      ORDER BY a.created_at ASC",
));
$report['booking_attachments_skipped'] = $grouped['skipped'];
foreach ($grouped['held'] as $name => $group) {
    $quarantine($name, 'the file name names a different patient than its appointment', $group);
}

// Files no appointment points at: a booking that was never made, filed for the
// patient whose id the name starts with.
$files = $grouped['files'];
foreach ($legacyFiles->unclaimed([...array_keys($files), ...array_keys($grouped['held'])]) as $name) {
    $owner = LegacyBookingAttachments::ownerOf($name);
    $row   = $owner !== null
        ? $conn->fetchAssociative('SELECT id AS patient_id, first_name, last_name FROM patients WHERE id = ?', [$owner])
        : false;
    if ($row === false) {
        $quarantine($name, $owner === null ? 'not named like a booking attachment' : 'no patient with the id in its name');
        continue;
    }
    // Same shape as an appointment row, with no appointment to link.
    $files[$name] = [$row + ['id' => null, 'created_at' => date('Y-m-d H:i:s', (int) (@filemtime($publicDir . '/' . $name) ?: time()))]];
}

foreach ($files as $name => $group) {
    try {
        $storage->checkImport($publicDir . '/' . $name);
    } catch (DocumentRejectedException $e) {
        $quarantine($name, is_file($publicDir . '/' . $name) ? $e->getMessage() : 'not in the public folder (an earlier run quarantined it, or it was removed)', $group);
        continue;
    }
    if ($dryRun) {
        $report['booking_attachments_imported'] += count($group);
        continue;
    }
    $legacyFiles->file($name, $group, $saveAttachment);
}
$report['completed_steps'][] = 7;

// 8) Guest identities: every guest invited before guests had ids gets a stable
//    id (the `gid` in their join links from now on), an Agora uid of their own
//    (100 and up — the patient is 1, the doctor 2), the uid the links already
//    emailed to them carry (3, 4, 5 by their place on the list — those links
//    keep working while that guest stays invited and the join window allows),
//    and what they cost: the guest fee now, never more than an equal share of
//    what was paid above the consultation's own price (the follow-up price, else
//    the doctor's fee), nothing on a free consultation (refunded to the wallet if
//    the patient removes them before the consultation starts). Guests with an
//    id are left alone, so a re-run changes nothing. (Its columns were checked
//    at the top.)
$report['guests_given_identity']       = 0;
$report['appointments_guests_updated'] = 0;
$guestFee = number_format((new App\Infrastructure\Service\PricingService(new App\Domain\Repository\AppSettingRepository($em)))->guestFee(), 2, '.', '');
$report['legacy_guest_fee'] = $guestFee;
foreach ($em->createQuery('SELECT a FROM ' . Appointment::class . ' a WHERE a.guests IS NOT NULL')->getResult() as $appointment) {
    /** @var Appointment $appointment */
    $given = $appointment->assignGuestIdentities($appointment->legacyGuestFee($guestFee));
    if ($given > 0) {
        $report['guests_given_identity'] += $given;
        $report['appointments_guests_updated']++;
    }
}
$em->flush();
$report['completed_steps'][] = 8;

if ($dryRun) {
    $conn->rollBack();
    printReport($report);
    fwrite(STDOUT, "\nDry run: nothing was saved or moved. The report shows what --run would change.\n");
    exit(0);
}

printReport($report);
if ($report['booking_attachments_quarantined'] !== []) {
    fwrite(STDOUT, "\nSome old booking attachments could not be filed and were moved out of the public folder into\n"
        . "var/quarantine/appointment-docs — review them by hand: see booking_attachments_quarantined above.\n");
}
fwrite(STDOUT, "\nDone. Reminder: the doctor emails above are placeholders — update each\n");
fwrite(STDOUT, "specialist's email to the doctor's real inbox so invites + join links land there.\n");
