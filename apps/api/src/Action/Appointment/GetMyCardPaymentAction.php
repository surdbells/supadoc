<?php

declare(strict_types=1);

namespace App\Action\Appointment;

use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\PaymentIntentService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/portal/card-payments/{reference} — where one of the signed-in
 * patient's own card checkouts (a pay-init reference) stands, so the app only
 * says "you've already paid" — and offers "Complete your paid booking" — for a
 * payment that was really made. A checkout not yet known to be paid is
 * checked with Paystack first ({@see PaymentIntentService::statusFor()}).
 *
 * `status`: `paid` (paid, unused: it can still pay for what it was made for;
 * else it reaches the wallet at `credit_due_at`), `not_paid`, `unconfirmed`
 * (Paystack couldn't be asked just now — try again later), `used`
 * (`used_for` = the appointment), `credited_to_wallet`, `review` (held for
 * support). Another patient's reference, or an unknown one: 404. Never cached.
 */
final class GetMyCardPaymentAction
{
    use ApiResponse;

    public function __construct(private readonly PaymentIntentService $intents)
    {
    }

    /** @param array<string,string> $args */
    public function __invoke(ServerRequestInterface $request, ResponseInterface $response, array $args): ResponseInterface
    {
        $status = $this->intents->statusFor((string) ($args['reference'] ?? ''), (string) $request->getAttribute('customer_id'));
        $answer = $status === null
            ? $this->error($response, 'Card payment not found', 404)
            : $this->success($response, $status);

        return $answer->withHeader('Cache-Control', 'no-store');
    }
}
