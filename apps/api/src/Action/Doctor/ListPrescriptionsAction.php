<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\PrescriptionRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Prescription\PrescriptionService;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/doctor/appointments/{id}/prescriptions — prescriptions the doctor has
 * issued in this consultation (their own appointment only).
 */
final class ListPrescriptionsAction
{
    use ApiResponse;
    use ResolvesDoctorAppointment;

    public function __construct(
        private readonly UserRepository $users,
        private readonly AppointmentRepository $appointments,
        private readonly PrescriptionRepository $prescriptions,
        private readonly PrescriptionService $service,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
        array $args,
    ): ResponseInterface {
        $id = (string) $args['id'];
        if ($this->doctorAppointment($request, $this->users, $this->appointments, $id) === null) {
            return $this->error($response, 'Consultation not found', 403);
        }

        $rows = $this->service->rowsFor($this->prescriptions->forAppointment($id), full: true);

        return $this->success($response, $rows);
    }
}
