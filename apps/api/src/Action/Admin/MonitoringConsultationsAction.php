<?php

declare(strict_types=1);

namespace App\Action\Admin;

use App\Domain\Entity\Appointment;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\RecordingRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/admin/monitoring/consultations — the most recent consultations with a
 * live "recording in progress" flag. Paginated. Behind RBAC `monitoring.view`.
 */
final class MonitoringConsultationsAction
{
    use ApiResponse;

    public function __construct(
        private readonly AppointmentRepository $appointments,
        private readonly RecordingRepository $recordings,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        $p    = $this->getPaginationParams((array) $request->getQueryParams());
        $page = $this->appointments->recent($p['offset'], $p['per_page']);

        // One query for all active-recording appointment ids — no N+1.
        $recording = array_fill_keys($this->recordings->activeAppointmentIds(), true);

        $items = array_map(
            static function (Appointment $a) use ($recording): array {
                $patient = $a->getPatient()->toArray();

                return [
                    'id'              => $a->getId(),
                    'patient_name'    => trim(($patient['first_name'] ?? '') . ' ' . ($patient['last_name'] ?? '')),
                    'specialist'      => $a->getSpecialist()->getName(),
                    'scheduled_at'    => $a->getScheduledAt()->format(DATE_ATOM),
                    'status'          => $a->getStatus()->value,
                    'status_label'    => $a->getStatus()->label(),
                    'recording_active' => isset($recording[$a->getId()]),
                ];
            },
            $page['items'],
        );

        return $this->paginated($response, $items, $page['total'], $p['page'], $p['per_page']);
    }
}
