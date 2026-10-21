<?php

declare(strict_types=1);

/**
 * Deploy smoke check for patient-controlled document sharing (DEPLOY.md
 * "One-time: private medical documents"). Read-only: it changes nothing.
 *
 * Prints:
 *  - cli_tz — this PHP CLI's time zone. Naive timestamps are stored in the
 *    PROCESS zone, so the CLI (cron, prod-migrate) must match PHP-FPM's (which
 *    /health/ready reports as `tz`). With --expect-tz=ZONE a mismatch exits 1.
 *  - flag — DOC_SHARING_ENABLED on / off.
 *  - tables / indexes — the seven sharing tables and their partial unique indexes.
 *  - active_grants, pending_requests, hidden_open — totals (all 0 right after
 *    the private cutover).
 *  - consultations_in_window — open consultations whose time (slot + 30 min)
 *    contains now; live_calls — those with someone in the call right now
 *    (CallPresence). The cutover hides documents mid-call: deploy at 0.
 *
 * Usage (inside apps/api):
 *   php bin/doc-sharing-check.php
 *   php bin/doc-sharing-check.php --expect-tz="$(curl -s https://vmapi.betacrest.com/health/ready | php -r 'echo json_decode(stream_get_contents(STDIN))->tz;')"
 *
 * Exit codes: 0 ok; 1 time zone mismatch; 2 the database could not be read.
 */

use App\Domain\Document\DocumentSharingRules;
use App\Domain\Entity\Appointment;
use App\Infrastructure\Persistence\RawIndexes;
use App\Infrastructure\Service\CallPresence;
use DI\ContainerBuilder;
use Doctrine\ORM\EntityManagerInterface;

require __DIR__ . '/../vendor/autoload.php';

Dotenv\Dotenv::createImmutable(__DIR__ . '/..')->safeLoad();

$expectTz = null;
foreach ($argv as $arg) {
    if (str_starts_with($arg, '--expect-tz=')) {
        $expectTz = trim(substr($arg, strlen('--expect-tz=')), " \"'");
    }
}

$out  = static function (string $line): void {
    fwrite(STDOUT, $line . "\n");
};
$exit = 0;

$cliTz = date_default_timezone_get();
$out('cli_tz=' . $cliTz);
if ($expectTz !== null) {
    if ($expectTz === '' || $expectTz !== $cliTz) {
        $out(sprintf('tz_check=MISMATCH (php-fpm reports "%s", this CLI runs in "%s" — make php.ini date.timezone match before going on)', $expectTz, $cliTz));
        $exit = 1;
    } else {
        $out('tz_check=ok');
    }
}
$out('flag=' . (DocumentSharingRules::enabled() ? 'on' : 'off'));

try {
    $builder = new ContainerBuilder();
    $builder->addDefinitions(__DIR__ . '/../config/container.php');
    $container = $builder->build();
    $em        = $container->get(EntityManagerInterface::class);
    $conn      = $em->getConnection();

    $tables  = ['document_access_grants', 'document_access_grant_documents', 'document_access_hidden', 'document_access_requests', 'document_access_blocks', 'document_access_log', 'document_access_submissions'];
    $present = array_map('strtolower', $conn->createSchemaManager()->listTableNames());
    $missing = array_values(array_diff($tables, $present));
    $out('tables=' . ($missing === [] ? 'present' : 'missing: ' . implode(', ', $missing) . ' (run the schema update)'));

    $indexes = [RawIndexes::DOC_ACTIVE_FOLDER, RawIndexes::DOC_CLIENT_KEY, RawIndexes::DOC_HIDDEN_OPEN, RawIndexes::DOC_REQUEST_PENDING, RawIndexes::DOC_BLOCK_OPEN];
    $noIndex = array_values(array_filter($indexes, static fn (string $name): bool => !RawIndexes::exists($conn, $name)));
    $out('indexes=' . ($noIndex === [] ? 'present' : 'missing: ' . implode(', ', $noIndex) . ' (run php bin/prod-migrate.php --run)'));

    $now = DocumentSharingRules::now();
    if ($missing === []) {
        $out(sprintf(
            'active_grants=%d pending_requests=%d hidden_open=%d',
            (int) $conn->fetchOne("SELECT COUNT(*) FROM document_access_grants WHERE status = 'active'"),
            (int) $conn->fetchOne("SELECT COUNT(*) FROM document_access_requests WHERE status = 'pending' AND expires_at > :now", ['now' => DocumentSharingRules::sql($now)]),
            (int) $conn->fetchOne('SELECT COUNT(*) FROM document_access_hidden WHERE cleared_at IS NULL'),
        ));
    } else {
        $out('active_grants=n/a pending_requests=n/a hidden_open=n/a');
    }

    // Consultations whose time contains now (slot + 30 minutes' grace), and
    // those with someone actually in the call.
    $ids = $conn->fetchFirstColumn(
        "SELECT a.id FROM appointments a JOIN specialists s ON s.id = a.specialist_id
          WHERE a.deleted_at IS NULL AND a.status IN ('pending', 'confirmed', 'rescheduled')
            AND a.scheduled_at <= :now
            AND a.scheduled_at + ((COALESCE(NULLIF(s.slot_minutes, 0), 30) + 30) * INTERVAL '1 minute') >= :now",
        ['now' => DocumentSharingRules::sql($now)],
    );
    $presence = $container->get(CallPresence::class);
    $live     = 0;
    foreach ($ids as $id) {
        $appointment = $em->find(Appointment::class, (string) $id);
        if (!$appointment instanceof Appointment) {
            continue;
        }
        $p = $presence->forAppointment($appointment);
        if ($p['doctor'] || $p['patient'] || $p['guests'] !== []) {
            $live++;
        }
    }
    $out(sprintf('consultations_in_window=%d live_calls=%d', count($ids), $live));
    if ($live > 0) {
        $out('advice=wait: the private cutover hides documents mid-call — deploy at live_calls=0');
    }
} catch (\Throwable $e) {
    fwrite(STDERR, 'database check failed: ' . $e::class . ': ' . $e->getMessage() . "\n");
    exit(2);
}

exit($exit);
