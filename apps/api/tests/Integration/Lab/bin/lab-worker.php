<?php

declare(strict_types=1);

/**
 * One "request" of a lab request integration test in its own PHP process (its
 * own container, EntityManager and database session), so two of them really
 * run at once (modelled on the document-sharing worker). Usage:
 *   php lab-worker.php <base64 json job>
 *   job: {schema, app, op: "doctor_action", class, user_id, method?, body?, query?, args?}
 *     or {schema, app, op: "patient_action", class, customer_id, method?, body?, query?, args?,
 *         file?: {path, name, mime}}   (the file is copied, then uploaded as `file`)
 *     or {schema, app, op: "staff_action", class, user_id, permissions, method?, body?, args?}
 * Prints one JSON line: {result: {status, body}} or {exception, message}.
 */

use App\Tests\Integration\Lab\Support\LabHarness;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response;
use Slim\Psr7\UploadedFile;

require dirname(__DIR__, 4) . '/vendor/autoload.php';

$job = json_decode((string) base64_decode((string) ($argv[1] ?? ''), true), true);
if (!is_array($job)) {
    fwrite(STDERR, "bad job\n");
    exit(2);
}
ini_set('error_log', sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'lab-it-worker.log');
$_ENV['DOC_SHARING_ENABLED'] = 'true';

$container = LabHarness::container((string) $job['schema'], (string) ($job['app'] ?? 'lab_worker'));

try {
    $request = (new ServerRequestFactory())->createServerRequest((string) ($job['method'] ?? 'POST'), '/api/test')
        ->withParsedBody((array) ($job['body'] ?? []))
        ->withQueryParams((array) ($job['query'] ?? []));
    $request = match ((string) $job['op']) {
        'doctor_action'  => $request->withAttribute('user_id', (string) $job['user_id'])->withAttribute('user_roles', ['doctor']),
        'patient_action' => $request->withAttribute('customer_id', (string) $job['customer_id']),
        'staff_action'   => $request->withAttribute('user_id', (string) $job['user_id'])->withAttribute('user_roles', ['staff'])
            ->withAttribute('user_permissions', (array) ($job['permissions'] ?? [])),
        default          => throw new \InvalidArgumentException('unknown op'),
    };
    if (is_array($job['file'] ?? null)) {
        $tmp = tempnam(sys_get_temp_dir(), 'labw');
        copy((string) $job['file']['path'], (string) $tmp);
        $request = $request->withUploadedFiles(['file' => new UploadedFile((string) $tmp, (string) $job['file']['name'], (string) $job['file']['mime'], (int) filesize((string) $tmp), UPLOAD_ERR_OK)]);
    }
    $response = $container->get((string) $job['class'])($request, new Response(), (array) ($job['args'] ?? []));
    $out      = ['result' => ['status' => $response->getStatusCode(), 'body' => json_decode((string) $response->getBody(), true)]];
} catch (\Throwable $e) {
    $out = ['exception' => $e::class, 'message' => $e->getMessage()];
}

fwrite(STDOUT, json_encode($out) . "\n");
