<?php

declare(strict_types=1);

namespace App\Action\Admin;

use App\Domain\Entity\Recording;
use App\Domain\Repository\RecordingRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/admin/monitoring/recordings — recent recording sessions across the
 * platform (active + finished). Behind RBAC `monitoring.view`.
 */
final class MonitoringRecordingsAction
{
    use ApiResponse;

    public function __construct(private readonly RecordingRepository $recordings)
    {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        $rows = array_map(
            static fn (Recording $r): array => $r->toArray(),
            $this->recordings->recent(100),
        );

        return $this->success($response, $rows);
    }
}
