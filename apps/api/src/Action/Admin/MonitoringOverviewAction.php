<?php

declare(strict_types=1);

namespace App\Action\Admin;

use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\AuditEventRepository;
use App\Domain\Repository\ClinicalNoteRepository;
use App\Domain\Repository\LabOrderRepository;
use App\Domain\Repository\PrescriptionRepository;
use App\Domain\Repository\RecordingRepository;
use App\Domain\Repository\ReferralRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/admin/monitoring/overview — platform-wide consultation activity for the
 * back-office dashboard. All counts come from real tables (no synthetic metrics).
 * Behind RBAC `monitoring.view`.
 */
final class MonitoringOverviewAction
{
    use ApiResponse;

    public function __construct(
        private readonly AppointmentRepository $appointments,
        private readonly ClinicalNoteRepository $notes,
        private readonly PrescriptionRepository $prescriptions,
        private readonly LabOrderRepository $labOrders,
        private readonly ReferralRepository $referrals,
        private readonly RecordingRepository $recordings,
        private readonly AuditEventRepository $audit,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        $byStatus = $this->appointments->statusCounts();

        return $this->success($response, [
            'appointments'   => [
                'total'     => array_sum($byStatus),
                'by_status' => $byStatus,
            ],
            'clinical_notes' => $this->notes->count(),
            'prescriptions'  => $this->prescriptions->count(),
            'lab_orders'     => $this->labOrders->count(),
            'referrals'      => $this->referrals->count(),
            'recordings'     => [
                'total'  => $this->recordings->count(),
                'active' => $this->recordings->countActive(),
            ],
            'audit_events'   => $this->audit->count(),
        ]);
    }
}
