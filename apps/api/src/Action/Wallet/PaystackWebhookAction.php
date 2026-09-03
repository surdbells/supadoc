<?php

declare(strict_types=1);

namespace App\Action\Wallet;

use App\Domain\Repository\WalletTransactionRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\PaystackService;
use App\Infrastructure\Service\WalletService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/webhooks/paystack — Paystack event backstop (public route). Verifies
 * the HMAC-SHA512 signature when the raw body is available, then RE-VERIFIES the
 * transaction with Paystack before settling (never trusts the payload alone). The
 * settlement is idempotent, so this and the client verify can both fire safely.
 */
final class PaystackWebhookAction
{
    use ApiResponse;

    public function __construct(
        private readonly WalletService $wallets,
        private readonly WalletTransactionRepository $txns,
        private readonly PaystackService $paystack,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        $stream = $request->getBody();
        try {
            $stream->rewind();
        } catch (\Throwable) {
            /* not seekable — parsed body is used instead */
        }
        $raw = $stream->getContents();
        $sig = $request->getHeaderLine('x-paystack-signature');

        // If we have the raw body and a signature, it must be valid.
        if ($raw !== '' && $sig !== '' && !$this->paystack->verifySignature($raw, $sig)) {
            return $this->error($response, 'Invalid signature', 401);
        }

        $event = $request->getParsedBody();
        if (!is_array($event) || $event === []) {
            $decoded = json_decode($raw, true);
            $event   = is_array($decoded) ? $decoded : [];
        }

        if (($event['event'] ?? '') === 'charge.success') {
            $data      = is_array($event['data'] ?? null) ? $event['data'] : [];
            $reference = (string) ($data['reference'] ?? '');
            $txn       = $reference !== '' ? $this->txns->byReference($reference) : null;

            if ($txn !== null && $txn->isPending()) {
                try {
                    $result = $this->paystack->verify($reference);
                    if ($result['status'] === 'success') {
                        $this->wallets->settleTopup($reference, $result['gateway_reference']);
                    }
                } catch (\RuntimeException) {
                    // Leave pending — Paystack retries the webhook, and the client
                    // verify is a second path to settlement.
                }
            }
        }

        // Acknowledge everything with 200 so Paystack doesn't retry handled events.
        return $this->success($response, ['received' => true]);
    }
}
