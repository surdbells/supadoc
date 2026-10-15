<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Domain\Call\CallAccess;
use App\Domain\Enum\AppointmentStatus;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\UserRepository;
use App\Domain\Settings\WebUrls;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\JwtService;
use DateTimeImmutable;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/doctor/appointments/{id} — one of the signed-in doctor's own
 * consultations, the same row GET /doctor/appointments lists: the appointment
 * plus `patient_name` and a freshly minted preauthenticated `join_url` (null
 * on a follow-up proposal the patient hasn't accepted yet). For the record
 * page and the links in notices, whatever the consultation's date — the list
 * only carries the schedule around today. Doctor-owned only (403 otherwise).
 * `join_blocked` ({code, message}) says why there is no link when the call
 * would refuse the doctor ({@see CallAccess::doctorProblem()}: suspended, not
 * approved, or terms_required for a consultation that hasn't started yet).
 */
final class GetDoctorAppointmentAction
{
    use ApiResponse;
    use ResolvesDoctorAppointment;

    public function __construct(
        private readonly UserRepository $users,
        private readonly AppointmentRepository $appointments,
        private readonly JwtService $jwt,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
        array $args,
    ): ResponseInterface {
        $appt = $this->doctorAppointment($request, $this->users, $this->appointments, (string) $args['id']);
        if ($appt === null) {
            return $this->error($response, 'Appointment not found', 403);
        }

        $specialist = $appt->getSpecialist();
        $patient    = $appt->getPatient()->toArray();
        // A doctor the call would refuse gets no link: suspended, not approved,
        // or owing the practitioner terms for a consultation not started yet.
        $blocked = CallAccess::doctorJoinBlocked($appt, new DateTimeImmutable());
        // An unaccepted follow-up proposal has no call yet: no link.
        $joinUrl = null;
        if ($appt->getStatus() !== AppointmentStatus::PROPOSED && $blocked === null) {
            $webUrl  = WebUrls::patientAppForStaffOrigin(WebUrls::requestStaffOrigin() ?? $specialist->getWebOrigin());
            $joinUrl = $webUrl . '/call/join/' . $this->jwt->issueCallAccess($appt->getId(), $specialist->getName(), 'doctor', 2);
        }

        return $this->success($response, $appt->toArray() + [
            'patient_name' => trim(((string) $patient['first_name']) . ' ' . ((string) $patient['last_name'])),
            'join_url'     => $joinUrl,
            'join_blocked' => $blocked,
        ]);
    }
}
