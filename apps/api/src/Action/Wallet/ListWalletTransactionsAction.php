<?php

declare(strict_types=1);

namespace App\Action\Wallet;

use App\Domain\Entity\WalletTransaction;
use App\Domain\Repository\WalletTransactionRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\WalletService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/portal/wallet/transactions — the patient's wallet ledger, paginated and
 * filterable by ?type= (topup | consultation | refund). Scoped by customer_id.
 */
final class ListWalletTransactionsAction
{
    use ApiResponse;

    public function __construct(
        private readonly WalletService $wallets,
        private readonly WalletTransactionRepository $txns,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        $customerId = (string) $request->getAttribute('customer_id');
        $query      = (array) $request->getQueryParams();

        $currency = strtoupper((string) ($query['currency'] ?? ''));
        if ($currency === '' || !$this->wallets->isSupported($currency)) {
            $currency = $this->wallets->defaultCurrency();
        }
        $wallet = $this->wallets->walletFor($customerId, $currency);

        $p    = $this->getPaginationParams($query);
        $type = isset($query['type']) ? (string) $query['type'] : null;
        $page = $this->txns->page($wallet->getId(), $p['offset'], $p['per_page'], $type);

        $items = array_map(
            static fn (WalletTransaction $t): array => $t->toArray(),
            $page['items'],
        );

        return $this->paginated($response, $items, $page['total'], $p['page'], $p['per_page']);
    }
}
