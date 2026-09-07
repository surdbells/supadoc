<?php

declare(strict_types=1);

namespace App\Action\Admin;

use App\Domain\Entity\Payout;
use App\Domain\Repository\PayoutRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/** GET /api/admin/payouts — all payout requests, paginated, optional ?status. */
final class ListPayoutsAction
{
    use ApiResponse;

    public function __construct(private readonly PayoutRepository $payouts)
    {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        $query  = $request->getQueryParams();
        $params = $this->getPaginationParams($query);
        $status = trim((string) ($query['status'] ?? '')) ?: null;

        $page  = $this->payouts->paginatedAll($params['offset'], $params['per_page'], $status);
        $items = array_map(static fn (Payout $p): array => $p->toArray(), $page['items']);

        return $this->paginated($response, $items, $page['total'], $params['page'], $params['per_page']);
    }
}
