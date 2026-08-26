<?php

declare(strict_types=1);

namespace App\Action\Admin;

use App\Domain\Entity\AuditEvent;
use App\Domain\Repository\AuditEventRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/admin/monitoring/audit — the platform audit log, newest first,
 * optionally filtered by ?action=. Paginated. Behind RBAC `monitoring.view`.
 */
final class MonitoringAuditAction
{
    use ApiResponse;

    public function __construct(private readonly AuditEventRepository $audit)
    {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        $query  = (array) $request->getQueryParams();
        $p      = $this->getPaginationParams($query);
        $action = isset($query['action']) ? (string) $query['action'] : null;

        $page  = $this->audit->page($p['offset'], $p['per_page'], $action);
        $items = array_map(
            static fn (AuditEvent $e): array => $e->toArray(),
            $page['items'],
        );

        return $this->paginated($response, $items, $page['total'], $p['page'], $p['per_page']);
    }
}
