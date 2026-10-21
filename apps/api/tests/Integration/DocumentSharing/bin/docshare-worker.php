<?php

declare(strict_types=1);

/**
 * One "request" of a document-sharing integration test in its own PHP process
 * (its own container, EntityManager and database session), so two of them
 * really run at once. Usage: php docshare-worker.php <base64 json job>
 *   job: {schema, app, op: "share", patient_id, input}
 *     or {schema, app, op: "update", patient_id, grant_id, input}
 * Prints one JSON line: {result} or {refusal: {status, code, errors}} or
 * {exception, message}.
 */

use App\Domain\Document\DocumentSharingRules;
use App\Domain\Document\DomainRefusal;
use App\Domain\Entity\Patient;
use App\Infrastructure\Document\DocumentSharingService;
use App\Tests\Integration\DocumentSharing\Support\DocShareHarness;
use Doctrine\ORM\EntityManagerInterface;

require dirname(__DIR__, 4) . '/vendor/autoload.php';

$job = json_decode((string) base64_decode((string) ($argv[1] ?? ''), true), true);
if (!is_array($job)) {
    fwrite(STDERR, "bad job\n");
    exit(2);
}
ini_set('error_log', sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'docshare-it-worker.log');
$_ENV['DOC_SHARING_ENABLED'] = 'true';

$container = DocShareHarness::container((string) $job['schema'], (string) ($job['app'] ?? 'docshare_worker'));
$em        = $container->get(EntityManagerInterface::class);

try {
    $out = match ((string) $job['op']) {
        'share' => ['result' => $container->get(DocumentSharingService::class)->share(
            $em->find(Patient::class, (string) $job['patient_id']),
            (array) $job['input'],
            DocumentSharingRules::now(),
        )],
        'update' => ['result' => $container->get(DocumentSharingService::class)->updateGrant(
            $em->find(Patient::class, (string) $job['patient_id']),
            (string) $job['grant_id'],
            (array) $job['input'],
            DocumentSharingRules::now(),
        )],
        default => throw new \InvalidArgumentException('unknown op'),
    };
} catch (DomainRefusal $r) {
    $out = ['refusal' => ['status' => $r->status, 'code' => $r->errorCode(), 'errors' => $r->errors]];
} catch (\Throwable $e) {
    $out = ['exception' => $e::class, 'message' => $e->getMessage()];
}

fwrite(STDOUT, json_encode($out) . "\n");
