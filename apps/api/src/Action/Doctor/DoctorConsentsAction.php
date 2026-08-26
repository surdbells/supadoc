<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Action\Consent\BuildsConsentState;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\ConsultationConsentRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/doctor/appointments/{id}/consents — the patient's consent decisions,
 * so the doctor knows (e.g.) whether recording is permitted before starting it.
 */
final class DoctorConsentsAction
{
    use ApiResponse;
    use ResolvesDoctorAppointment;
    use BuildsConsentState;

    public function __construct(
        private readonly UserRepository $users,
        private readonly AppointmentRepository $appointments,
        private readonly ConsultationConsentRepository $consents,
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

        return $this->success($response, $this->consentState($this->consents, $id));
    }
}
