<?php

declare(strict_types=1);

namespace App\Action\Wallet;

use App\Domain\Repository\WalletTransactionRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\CardPaymentGateway;
use App\Infrastructure\Service\PaymentIntentService;
use App\Infrastructure\Service\PaystackService;
use App\Infrastructure\Service\WalletService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/webhooks/paystack — Paystack's event backstop (public route).
 *
 *  - The `x-paystack-signature` HMAC-SHA512 of the raw body is REQUIRED: a
 *    missing or wrong one is 401 and nothing is read from the payload.
 *  - `charge.success` is settled by reference, never on the payload's word:
 *    the transaction is re-verified with Paystack first. A wallet top-up is
 *    credited through {@see WalletService::settleTopup()} (at most once, and
 *    only when the verified amount and currency are what the top-up
 *    expected); a card checkout ({@see PaymentIntentService::recordCharge()})
 *    is marked paid — the patient's booking request uses it, or the cron
 *    sweep credits it to their wallet once it has gone unused for a while.
 *  - Paystack can't be reached, or its verify doesn't call the charge final
 *    yet (pending / ongoing / not found just after the event) → 503, so
 *    Paystack sends the event again; a database failure is a 500 for the same
 *    reason. A charge Paystack calls failed / abandoned / reversed is answered
 *    200 (nothing to settle, ever). Everything settled is idempotent, so
 *    repeated or out-of-order deliveries are answered 200 and change nothing.
 *    Other events are acknowledged (200) and ignored.
 *
 * Exempt from the per-IP rate limit (config/middleware.php): Paystack sends
 * every event from a few addresses, and the signature check is the gate.
 */
final class PaystackWebhookAction
{
    use ApiResponse;

    public function __construct(
        private readonly WalletService $wallets,
        private readonly WalletTransactionRepository $txns,
        private readonly PaystackService $paystack,
        private readonly CardPaymentGateway $gateway,
        private readonly PaymentIntentService $intents,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        // The exact bytes Paystack signed (Slim caches php://input, so the
        // JSON body parser having read it already doesn't matter).
        $raw = (string) $request->getBody();
        $sig = trim($request->getHeaderLine('x-paystack-signature'));
        if ($raw === '' || $sig === '' || !$this->paystack->verifySignature($raw, $sig)) {
            return $this->error($response, 'Invalid signature', 401);
        }

        $event = json_decode($raw, true);
        if (!is_array($event) || ($event['event'] ?? '') !== 'charge.success') {
            return $this->success($response, ['received' => true, 'handled' => false]);
        }
        $data      = is_array($event['data'] ?? null) ? $event['data'] : [];
        $reference = trim((string) ($data['reference'] ?? ''));
        if ($reference === '') {
            return $this->success($response, ['received' => true, 'handled' => false]);
        }

        try {
            $outcome = $this->settle($reference, is_array($data['metadata'] ?? null) ? $data['metadata'] : []);
        } catch (\RuntimeException $e) {
            // Paystack couldn't confirm it just now: ask Paystack to send it again.
            error_log(sprintf('[paystack.webhook] could not verify %s yet: %s', $reference, $e->getMessage()));

            return $this->error($response, 'Could not confirm the payment yet — please retry', 503);
        }

        return $this->success($response, ['received' => true, 'handled' => true, 'outcome' => $outcome]);
    }

    /**
     * @param array<string,mixed> $metadata
     * @throws \RuntimeException when Paystack can't be asked right now
     */
    private function settle(string $reference, array $metadata): string
    {
        $topup = $this->txns->byReference($reference);
        if ($topup === null) {
            $outcome = $this->intents->recordCharge($reference, $metadata);
            if ($outcome === 'pending') {
                throw new \RuntimeException('Paystack does not call the charge final yet');
            }

            return 'card_' . $outcome;
        }
        if (!$topup->isTopup()) {
            return 'ignored';
        }
        if ($topup->isSuccess()) {
            return 'topup_already_settled';
        }

        $verified = $this->gateway->verify($reference);
        if (PaymentIntentService::isStillOpen((string) $verified['status'])) {
            // charge.success, yet not final on verify (just after the event): Paystack must retry —
            // nothing else re-checks a top-up the patient's browser never confirmed.
            throw new \RuntimeException('Paystack does not call the top-up final yet (' . $verified['status'] . ')');
        }
        if ($verified['status'] !== 'success') {
            return 'topup_not_paid';
        }

        try {
            $posted = $this->wallets->settleTopup(
                $reference,
                (string) $verified['amount_minor'],
                (string) $verified['currency'],
                $verified['gateway_reference'] ?? null,
                [
                    'gross_amount_minor'     => $verified['gross_amount_minor'] ?? null,
                    'fees_minor'             => $verified['fees_minor'] ?? null,
                    'requested_amount_minor' => $verified['requested_amount_minor'] ?? null,
                ],
            );
        } catch (\InvalidArgumentException $e) {
            // An unusable verified amount: nothing changed — ask for the event again later.
            throw new \RuntimeException('Unusable verified amount: ' . $e->getMessage(), 0, $e);
        }

        return $posted !== null ? 'topup_settled' : 'topup_not_credited';
    }
}
