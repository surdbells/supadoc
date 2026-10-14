<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Domain\Entity\Appointment;
use App\Domain\Enum\AppointmentStatus;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\JwtService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use App\Domain\Settings\WebUrls;

/**
 * GET /api/doctor/appointments — the signed-in doctor's own consultations:
 * their schedule, soonest first — today's and what's coming, then, if there
 * is room, the most recent earlier ones ({@see AppointmentRepository::forSpecialist()};
 * GET /doctor/appointments/{id} loads any one).
 * Staff-scoped; the account must be a doctor login (role `doctor`, linked to a
 * Specialist). Each row carries a freshly minted preauthenticated `join_url` so
 * the doctor can jump straight into the call — null on a follow-up proposal
 * the patient hasn't accepted yet.
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

        $webUrl = WebUrls::patientAppForStaffOrigin(WebUrls::requestStaffOrigin() ?? $specialist->getWebOrigin());
        $rows   = array_map(function (Appointment $appt) use ($specialist, $webUrl): array {
            $patient = $appt->getPatient()->toArray();
            // An unaccepted follow-up proposal has no call yet: no link (the
            // same token would work the moment the patient accepts).
            $token   = $appt->getStatus() === AppointmentStatus::PROPOSED ? null : $this->jwt->issueCallAccess(
                $appt->getId(),
                $specialist->getName(),
                'doctor',
                2,
            );

            return $appt->toArray() + [
                'patient_name' => trim(((string) $patient['first_name']) . ' ' . ((string) $patient['last_name'])),
                'join_url'     => $token !== null ? $webUrl . '/call/join/' . $token : null,
            ];
        }, $this->appointments->forSpecialist($specialist->getId()));

        return $this->success($response, [
            'specialist'   => $specialist->toArray(),
            'appointments' => $rows,
        ]);
    }
}
