<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Domain\Entity\LabOrder;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\LabOrderRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/** GET /api/doctor/appointments/{id}/lab-orders — orders placed in this consultation. */
final class ListLabOrdersAction
{
    use ApiResponse;
    use ResolvesDoctorAppointment;

    public function __construct(
        private readonly UserRepository $users,
        private readonly AppointmentRepository $appointments,
        private readonly LabOrderRepository $orders,
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

        $rows = array_map(
            static fn (LabOrder $o): array => $o->toArray(),
            $this->orders->forAppointment($id),
        );

        return $this->success($response, $rows);
    }
}
