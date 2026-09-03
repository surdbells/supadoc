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
 * POST /api/portal/wallet/verify — confirm a top-up after the Paystack redirect.
 * Re-verifies with Paystack (never trusts the client), then settles the pending
 * ledger entry idempotently. The webhook is a backstop for the same settlement.
 */
final class VerifyFundingAction
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
        $customerId = (string) $request->getAttribute('customer_id');
        $body       = (array) ($request->getParsedBody() ?? []);
        $reference  = trim((string) ($body['reference'] ?? ($request->getQueryParams()['reference'] ?? '')));

        if ($reference === '') {
            return $this->error($response, 'Missing payment reference', 422);
        }

        $txn = $this->txns->byReference($reference);
        // Not found, or not this patient's entry — same opaque 404 either way.
        if ($txn === null || $txn->getPatientId() !== $customerId) {
            return $this->error($response, 'Transaction not found', 404);
        }

        // Already settled — return the current state (idempotent, no re-charge).
        if ($txn->isSuccess()) {
            $wallet = $this->wallets->walletFor($customerId, $txn->getCurrency());

            return $this->success($response, [
                'status'      => 'success',
                'wallet'      => $wallet->toArray(),
                'transaction' => $txn->toArray(),
            ]);
        }

        try {
            $result = $this->paystack->verify($reference);
        } catch (\RuntimeException $e) {
            return $this->error($response, 'Could not verify the payment. Please try again.', 502);
        }

        if ($result['status'] !== 'success') {
            $this->wallets->failTopup($reference);

            return $this->success($response, ['status' => $result['status']], 'Payment not completed');
        }

        $settled = $this->wallets->settleTopup($reference, $result['gateway_reference']);
        $wallet  = $this->wallets->walletFor($customerId, $settled->getCurrency());

        return $this->success($response, [
            'status'      => 'success',
            'wallet'      => $wallet->toArray(),
            'transaction' => $settled->toArray(),
        ], 'Wallet funded')->withHeader('Cache-Control', 'no-store');
    }
}
