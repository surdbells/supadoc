<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Domain\Entity\Appointment;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\JwtService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/doctor/appointments — the signed-in doctor's own consultations.
 * Staff-scoped; the account must be a doctor login (role `doctor`, linked to a
 * Specialist). Each row carries a freshly minted preauthenticated `join_url` so
 * the doctor can jump straight into the call.
 */
final class DoctorAppointmentsAction
{
    use ApiResponse;

    public function __construct(
        private readonly UserRepository $users,
        private readonly SpecialistRepository $specialists,
        private readonly AppointmentRepository $appointments,
        private readonly JwtService $jwt,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        $userId = (string) $request->getAttribute('user_id');
        $user   = $this->users->find($userId);

        if ($user === null || !in_array('doctor', $user->getRoles(), true) || $user->getSpecialistId() === null) {
            return $this->error($response, 'This account is not a doctor login', 403);
        }

        $specialist = $this->specialists->find($user->getSpecialistId());
        if ($specialist === null) {
            return $this->error($response, 'Doctor profile not found', 404);
        }

        $webUrl = rtrim((string) ($_ENV['APP_WEB_URL'] ?? 'http://localhost:4201'), '/');
        $rows   = array_map(function (Appointment $appt) use ($specialist, $webUrl): array {
            $patient = $appt->getPatient()->toArray();
            $token   = $this->jwt->issueCallAccess(
                $appt->getId(),
                $specialist->getName(),
                'doctor',
                2,
            );

            return $appt->toArray() + [
                'patient_name' => trim(((string) $patient['first_name']) . ' ' . ((string) $patient['last_name'])),
                'join_url'     => $webUrl . '/call/join/' . $token,
            ];
        }, $this->appointments->forSpecialist($specialist->getId()));

        return $this->success($response, [
            'specialist'   => $specialist->toArray(),
            'appointments' => $rows,
        ]);
    }
}
