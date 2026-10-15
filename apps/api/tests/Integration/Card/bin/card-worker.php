<?php

declare(strict_types=1);

/**
 * One "request" of a card-payment integration test, in its own PHP process
 * (its own container, EntityManager and database session) so two of them
 * really run at once. Usage: php card-worker.php <base64 json job>
 *   job: {schema, gateway_file, app, op, ...}
 *   op:  book     {customer_id, body}               → POST /api/portal/appointments
 *        accept   {customer_id, appointment_id, body} → POST .../follow-up/accept
 *        guest    {customer_id, appointment_id, body} → POST .../guests
 *        webhook  {raw, signature}                  → POST /api/webhooks/paystack
 *        reschedule {customer_id, appointment_id, body} → POST .../reschedule
 *        settle   {reference}                       → PaymentIntentService::settleUnused()
 * Prints one JSON line: {status, body} for a request, {result} for a call,
 * {exception, message} when it threw — each with `receipts`, the wallet
 * receipt e-mails it sent.
 */

use App\Action\Appointment\AcceptFollowUpAction;
use App\Action\Appointment\AddMyGuestAction;
use App\Action\Appointment\CreateMyAppointmentAction;
use App\Action\Wallet\PaystackWebhookAction;
use App\Domain\Exception\ValidationException;
use App\Infrastructure\Service\PaymentIntentService;
use App\Tests\Integration\Card\Support\CardHarness;
use Slim\Psr7\Factory\ResponseFactory;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Factory\StreamFactory;

require dirname(__DIR__, 4) . '/vendor/autoload.php';

$job = json_decode((string) base64_decode((string) ($argv[1] ?? ''), true), true);
if (!is_array($job)) {
    fwrite(STDERR, "bad job\n");
    exit(2);
}
ini_set('error_log', sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'card-it-worker.log');

$container = CardHarness::container((string) $job['schema'], (string) $job['gateway_file'], (string) ($job['app'] ?? 'card_worker'));
$receipts  = CardHarness::recordReceipts($container);
$requests  = new ServerRequestFactory();
$response  = (new ResponseFactory())->createResponse();

$asJson = static function (\Psr\Http\Message\ResponseInterface $res): array {
    return ['status' => $res->getStatusCode(), 'body' => json_decode((string) $res->getBody(), true)];
};

try {
    $out = match ((string) $job['op']) {
        'book' => $asJson($container->get(CreateMyAppointmentAction::class)(
            $requests->createServerRequest('POST', '/api/portal/appointments')
                ->withAttribute('customer_id', (string) $job['customer_id'])
                ->withParsedBody((array) $job['body']),
            $response,
        )),
        'accept' => $asJson($container->get(AcceptFollowUpAction::class)(
            $requests->createServerRequest('POST', '/api/portal/appointments/' . $job['appointment_id'] . '/follow-up/accept')
                ->withAttribute('customer_id', (string) $job['customer_id'])
                ->withParsedBody((array) $job['body']),
            $response,
            ['id' => (string) $job['appointment_id']],
        )),
        'guest' => $asJson($container->get(AddMyGuestAction::class)(
            $requests->createServerRequest('POST', '/api/portal/appointments/' . $job['appointment_id'] . '/guests')
                ->withAttribute('customer_id', (string) $job['customer_id'])
                ->withParsedBody((array) $job['body']),
            $response,
            ['id' => (string) $job['appointment_id']],
        )),
        'webhook' => $asJson($container->get(PaystackWebhookAction::class)(
            $requests->createServerRequest('POST', '/api/webhooks/paystack')
                ->withHeader('Content-Type', 'application/json')
                ->withHeader('x-paystack-signature', (string) $job['signature'])
                ->withBody((new StreamFactory())->createStream((string) $job['raw'])),
            $response,
        )),
        'reschedule' => $asJson($container->get(\App\Action\Appointment\ReschedulePortalAppointmentAction::class)(
            $requests->createServerRequest('POST', '/api/portal/appointments/' . $job['appointment_id'] . '/reschedule')
                ->withAttribute('customer_id', (string) $job['customer_id'])
                ->withParsedBody((array) $job['body']),
            $response,
            ['id' => (string) $job['appointment_id']],
        )),
        'settle' => ['result' => $container->get(PaymentIntentService::class)->settleUnused((string) $job['reference'])],
        default  => throw new \InvalidArgumentException('unknown op ' . $job['op']),
    };
} catch (ValidationException $e) {
    // What the error handler would answer: 422 with the field errors.
    $out = ['status' => 422, 'body' => ['status' => 'error', 'message' => $e->getMessage(), 'errors' => $e->getErrors()]];
} catch (\Throwable $e) {
    $out = ['exception' => $e::class, 'message' => $e->getMessage()];
}
$out['receipts'] = CardHarness::receipts($receipts);

echo json_encode($out), "\n";
