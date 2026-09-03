<?php

declare(strict_types=1);

namespace App\Action\Wallet;

use App\Domain\Entity\WalletTransaction;
use App\Domain\Repository\WalletTransactionRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\PaystackService;
use App\Infrastructure\Service\WalletService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/portal/wallet — the signed-in patient's wallet for a currency (NGN by
 * default), with the supported currency list and a few recent ledger entries.
 */
final class GetWalletAction
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
        $currency   = strtoupper((string) (($request->getQueryParams()['currency'] ?? '')));
        if ($currency === '' || !$this->wallets->isSupported($currency)) {
            $currency = $this->wallets->defaultCurrency();
        }

        $wallet = $this->wallets->walletFor($customerId, $currency);
        $recent = array_map(
            static fn (WalletTransaction $t): array => $t->toArray(),
            $this->txns->recentSuccessful($wallet->getId(), 4),
        );

        return $this->success($response, [
            'currency'     => $wallet->getCurrency(),
            'balance'      => $wallet->getBalance(),
            'status'       => $wallet->getStatus(),
            'currencies'   => $this->wallets->supportedCurrencies(),
            'funding_ready' => $this->paystack->isConfigured(),
            'recent'       => $recent,
        ])->withHeader('Cache-Control', 'no-store');
    }
}
