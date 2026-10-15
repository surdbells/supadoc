<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Domain\Entity\Appointment;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/doctor/appointments/{id}/follow-ups — every follow-up of
 * consultation {id} (proposed, accepted, declined, withdrawn, expired,
 * booked by the patient…), soonest first, each with the patient's name.
 * Doctor-owned only.
 */
final class ListFollowUpsAction
{
    use ApiResponse;
    use ResolvesDoctorAppointment;

    public function __construct(
        private readonly UserRepository $users,
        private readonly AppointmentRepository $appointments,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
        array $args,
    ): ResponseInterface {
        $parent = $this->doctorAppointment($request, $this->users, $this->appointments, (string) $args['id']);
        if ($parent === null) {
            return $this->error($response, 'You cannot manage this appointment', 403);
        }

        $rows = array_map(static function (Appointment $a): array {
            $patient = $a->getPatient()->toArray();

            return $a->toArray('doctor') + [
                'patient_name' => trim(((string) $patient['first_name']) . ' ' . ((string) $patient['last_name'])),
            ];
        }, $this->appointments->followUpsOf($parent->getId()));

        return $this->success($response, $rows);
    }
}
