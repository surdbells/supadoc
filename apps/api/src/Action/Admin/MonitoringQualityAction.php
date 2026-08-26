<?php

declare(strict_types=1);

namespace App\Action\Admin;

use App\Domain\Entity\Appointment;
use App\Domain\Entity\SessionMetric;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\SessionMetricRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/admin/monitoring/quality — RTC connection quality per consultation,
 * from the samples the call clients report. Reduces the recent sample stream to
 * the latest per (consultation, role). Behind RBAC `monitoring.view`.
 */
final class MonitoringQualityAction
{
    use ApiResponse;

    public function __construct(
        private readonly SessionMetricRepository $metrics,
        private readonly AppointmentRepository $appointments,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        $recent = $this->metrics->recent(400);

        // First-seen wins because the stream is newest-first.
        $latest = [];
        $order  = [];
        foreach ($recent as $m) {
            $aid = $m->getAppointmentId();
            if (!isset($latest[$aid])) {
                $latest[$aid] = [];
                $order[]      = $aid;
            }
            $role = $m->getRole();
            if (!isset($latest[$aid][$role])) {
                $latest[$aid][$role] = $this->sample($m);
            }
        }

        $rows = [];
        foreach (array_slice($order, 0, 25) as $aid) {
            /** @var Appointment|null $appt */
            $appt = $this->appointments->find($aid);
            if ($appt === null) {
                continue;
            }
            $patient = $appt->getPatient()->toArray();
            $p       = $latest[$aid]['patient'] ?? null;
            $d       = $latest[$aid]['doctor'] ?? null;

            $rows[] = [
                'appointment_id' => $aid,
                'patient_name'   => trim(($patient['first_name'] ?? '') . ' ' . ($patient['last_name'] ?? '')),
                'specialist'     => $appt->getSpecialist()->getName(),
                'patient'        => $p,
                'doctor'         => $d,
                'worst'          => max($p['worst'] ?? 0, $d['worst'] ?? 0),
            ];
        }

        return $this->success($response, [
            'average_rtt'   => $this->metrics->averageRtt(),
            'consultations' => $rows,
        ]);
    }

    /** @return array{uplink:int,downlink:int,rtt:?int,worst:int,at:string} */
    private function sample(SessionMetric $m): array
    {
        $row = $m->toArray();

        return [
            'uplink'   => $m->getUplink(),
            'downlink' => $m->getDownlink(),
            'rtt'      => $m->getRtt(),
            'worst'    => $m->worst(),
            'at'       => $row['created_at'],
        ];
    }
}
