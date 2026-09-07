<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Domain\Entity\Appointment;
use App\Domain\Entity\Patient;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\PatientRepository;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/doctor/patients/{id} — a patient's record, but only if they have
 * consulted with this doctor: basic details, medical summary (allergies /
 * conditions / medications) and their visit history with this doctor.
 */
final class DoctorPatientDetailAction
{
    use ApiResponse;
    use ResolvesDoctorSpecialist;

    public function __construct(
        private readonly UserRepository $users,
        private readonly SpecialistRepository $specialists,
        private readonly AppointmentRepository $appointments,
        private readonly PatientRepository $patients,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
        array $args,
    ): ResponseInterface {
        $specialist = $this->doctorSpecialist($request, $this->users, $this->specialists);
        if ($specialist === null) {
            return $this->error($response, 'This account is not a doctor profile', 403);
        }

        $patientId = (string) $args['id'];
        if (!$this->appointments->hasAppointmentWith($specialist->getId(), $patientId)) {
            return $this->error($response, 'Patient not found', 404);
        }

        $patient = $this->patients->find($patientId);
        if (!$patient instanceof Patient) {
            return $this->error($response, 'Patient not found', 404);
        }

        $p       = $patient->toArray();
        $history = array_map(
            static fn (Appointment $a): array => $a->toArray(),
            $this->appointments->forSpecialistAndPatient($specialist->getId(), $patientId),
        );

        return $this->success($response, [
            'patient' => [
                'id'            => $p['id'],
                'name'          => trim(((string) $p['first_name']) . ' ' . ((string) $p['last_name'])),
                'email'         => $p['email'],
                'phone'         => $p['phone'],
                'gender'        => $p['gender'],
                'date_of_birth' => $p['date_of_birth'],
            ],
            'medical'      => $patient->getMedical(),
            'appointments' => $history,
            'visit_count'  => count($history),
        ]);
    }
}
