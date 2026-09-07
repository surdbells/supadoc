<?php

declare(strict_types=1);

namespace App\Action\Admin;

use App\Domain\Repository\AppointmentRepository;
use App\Infrastructure\Service\ApiResponse;
use DateInterval;
use DateTimeImmutable;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/admin/analytics?range=30d — booking + revenue analytics for the back
 * office. Revenue counts only paid consultations (refunds excluded). Behind RBAC
 * `monitoring.view`. All aggregation is done in PHP over scalar rows, so it is
 * database-portable and needs no vendor date functions.
 */
final class AnalyticsAction
{
    use ApiResponse;

    /** Supported windows → [days back, granularity]. */
    private const RANGES = [
        '7d'  => [7, 'day'],
        '30d' => [30, 'day'],
        '90d' => [90, 'day'],
        '12m' => [365, 'month'],
    ];

    public function __construct(private readonly AppointmentRepository $appointments)
    {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        $range = (string) ($request->getQueryParams()['range'] ?? '30d');
        if (!isset(self::RANGES[$range])) {
            $range = '30d';
        }
        [$daysBack, $granularity] = self::RANGES[$range];

        $to   = new DateTimeImmutable('today 23:59:59');
        $from = $to->sub(new DateInterval('P' . ($daysBack - 1) . 'D'))->setTime(0, 0);

        $rows = $this->appointments->analyticsRows($from, $to);

        // Buckets keyed by label, pre-filled so the series has no gaps.
        $buckets = $this->emptyBuckets($from, $to, $granularity);

        $revenue    = '0.00';
        $paidCount  = 0;
        $completed  = 0;
        $byStatus   = [];
        $byType     = [];
        $bySpecial  = [];

        foreach ($rows as $r) {
            $created = $r['created_at'];
            $label   = $granularity === 'month' ? $created->format('Y-m') : $created->format('Y-m-d');
            $paid    = $r['payment_status'] === 'paid';
            $amount  = $paid ? $r['amount'] : '0.00';

            if (isset($buckets[$label])) {
                $buckets[$label]['appointments']++;
                $buckets[$label]['revenue'] = bcadd($buckets[$label]['revenue'], $amount, 2);
            }

            if ($paid) {
                $revenue = bcadd($revenue, $r['amount'], 2);
                $paidCount++;
            }
            if ($r['status'] === 'completed') {
                $completed++;
            }

            $byStatus[$r['status']] = ($byStatus[$r['status']] ?? 0) + 1;
            $byType[$r['type']]     = ($byType[$r['type']] ?? 0) + 1;

            $sid = $r['specialist_id'];
            if ($sid !== '') {
                $bySpecial[$sid] ??= ['id' => $sid, 'name' => $r['specialist_name'], 'appointments' => 0, 'revenue' => '0.00'];
                $bySpecial[$sid]['appointments']++;
                if ($paid) {
                    $bySpecial[$sid]['revenue'] = bcadd($bySpecial[$sid]['revenue'], $r['amount'], 2);
                }
            }
        }

        $total = count($rows);

        // Top specialists by revenue, then volume.
        usort($bySpecial, static function (array $a, array $b): int {
            $cmp = bccomp($b['revenue'], $a['revenue'], 2);

            return $cmp !== 0 ? $cmp : $b['appointments'] <=> $a['appointments'];
        });

        return $this->success($response, [
            'range'       => $range,
            'granularity' => $granularity,
            'from'        => $from->format(DATE_ATOM),
            'to'          => $to->format(DATE_ATOM),
            'kpis'        => [
                'appointments'    => $total,
                'revenue'         => $revenue,
                'paid_count'      => $paidCount,
                'avg_fee'         => $paidCount > 0 ? bcdiv($revenue, (string) $paidCount, 2) : '0.00',
                'completion_rate' => $total > 0 ? round($completed / $total * 100, 1) : 0.0,
            ],
            'series'          => array_values($buckets),
            'by_status'       => $byStatus,
            'by_type'         => $byType,
            'top_specialists' => array_slice($bySpecial, 0, 5),
        ]);
    }

    /**
     * A continuous, zero-filled map of bucket label => row, so the chart never
     * has holes on quiet days/months.
     *
     * @return array<string, array{label: string, appointments: int, revenue: string}>
     */
    private function emptyBuckets(DateTimeImmutable $from, DateTimeImmutable $to, string $granularity): array
    {
        $buckets = [];
        $step    = $granularity === 'month' ? 'P1M' : 'P1D';
        $fmt     = $granularity === 'month' ? 'Y-m' : 'Y-m-d';

        $cursor = $granularity === 'month' ? $from->modify('first day of this month')->setTime(0, 0) : $from;
        while ($cursor <= $to) {
            $label           = $cursor->format($fmt);
            $buckets[$label] = ['label' => $label, 'appointments' => 0, 'revenue' => '0.00'];
            $cursor          = $cursor->add(new DateInterval($step));
        }

        return $buckets;
    }
}
