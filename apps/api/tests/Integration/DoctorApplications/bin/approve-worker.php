<?php

declare(strict_types=1);

/**
 * One real HTTP request of a doctor-application integration test in its own
 * PHP process (its own container, EntityManager and database session), so two
 * of them really run at once. Approves one application (POST /api/doctor-applications/{id}/approve as a reviewer) — ApprovalRaceTest runs two at once.
 *
 * Usage: php approve-worker.php <base64 json job>
 *   job: {schema, app, method, path, body, token}
 * Prints one JSON line: {status, body} or {exception, message}.
 */

use App\Tests\Integration\DoctorApplications\Support\ApplicationsHarness;

require dirname(__DIR__, 4) . '/vendor/autoload.php';

$job = json_decode((string) base64_decode((string) ($argv[1] ?? ''), true), true);
if (!is_array($job)) {
    fwrite(STDERR, "bad job\n");
    exit(2);
}
ini_set('error_log', sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'docapp-it-worker.log');

try {
    $res = ApplicationsHarness::http(
        (string) $job['schema'],
        (string) $job['method'],
        (string) $job['path'],
        is_array($job['body'] ?? null) ? $job['body'] : null,
        isset($job['token']) ? (string) $job['token'] : null,
        null,
        [],
        (string) ($job['app'] ?? 'docapp_worker'),
    );
    $out = ['status' => $res['status'], 'body' => $res['body']];
} catch (\Throwable $e) {
    $out = ['exception' => $e::class, 'message' => $e->getMessage()];
}

fwrite(STDOUT, json_encode($out) . "\n");
