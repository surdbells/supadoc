<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\CarePlanRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/** GET /api/doctor/appointments/{id}/care-plan — the consultation's care plan (editable). */
final class GetCarePlanAction
{
    use ApiResponse;
    use ResolvesDoctorAppointment;

    public function __construct(
        private readonly UserRepository $users,
        private readonly AppointmentRepository $appointments,
        private readonly CarePlanRepository $plans,
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

        $plan = $this->plans->findByAppointment($id);
        if ($plan === null) {
            return $this->success($response, [
                'appointment_id' => $id,
                'items'          => [],
                'published'      => false,
                'author'         => null,
                'updated_at'     => null,
            ]);
        }

        return $this->success($response, $plan->toArray());
    }
}
