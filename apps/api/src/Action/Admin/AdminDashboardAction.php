<?php

declare(strict_types=1);

namespace App\Action\Admin;

use App\Domain\Dashboard\DashboardPeriod;
use App\Infrastructure\Availability\BookingFrame;
use App\Infrastructure\Service\AdminDashboardService;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/admin/dashboard?period=today|7d|30d&tz=&refresh= — the back-office
 * home: KPI tiles against the previous equal period, consultations live now and
 * starting soon, the queues that need someone, 30-day daily trends, and
 * breakdowns (status, specialties, doctors, recent activity).
 *
 * Each part is included only for staff holding a permission its back-office
 * page needs ({@see AdminDashboardService::PARTS}); `parts` / `sections` say
 * what came back. `tz` is the viewer's IANA zone (default the clinic's): it
 * decides where "today" and each trend day start. `refresh=1` skips the short
 * server cache. 403 for a caller who can see none of it (e.g. a doctor login);
 * 422 for an unknown period.
 */
final class AdminDashboardAction
{
    use ApiResponse;

    public function __construct(private readonly AdminDashboardService $dashboard)
    {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        $query  = $request->getQueryParams();
        $raw    = $query['period'] ?? null;
        $period = ($raw === null || $raw === '') ? DashboardPeriod::DEFAULT_PERIOD : DashboardPeriod::parse($raw);
        if ($period === null) {
            return $this->error($response, 'Validation failed', 422, [
                'period' => 'Use one of: ' . implode(', ', DashboardPeriod::PERIODS),
            ]);
        }

        /** @var list<string> $roles */
        $roles = array_values(array_map('strval', (array) $request->getAttribute('user_roles', [])));
        /** @var list<string> $permissions */
        $permissions = array_values(array_map('strval', (array) $request->getAttribute('user_permissions', [])));
        $parts       = AdminDashboardService::grantedParts($roles, $permissions);
        if ($parts === []) {
            return $this->error($response, 'Insufficient permissions', 403);
        }
        if (in_array('super_admin', $roles, true)) {
            // super_admin passes every page guard: give them every link too.
            $permissions = array_values(array_unique(array_merge(
                $permissions,
                ...array_values(AdminDashboardService::PARTS),
            )));
        }

        $fresh = in_array(strtolower((string) ($query['refresh'] ?? '')), ['1', 'true', 'yes'], true);
        $data  = $this->dashboard->build(
            DashboardPeriod::of($period, BookingFrame::zone($query['tz'] ?? null)),
            $parts,
            $permissions,
            $fresh,
        );

        return $this->success($response, $data);
    }
}
