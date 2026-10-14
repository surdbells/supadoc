<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Domain\Entity\MedicalCertificate;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\MedicalCertificateRepository;
use App\Domain\Repository\UserRepository;
use App\Domain\Settings\ScheduleRules;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/doctor/appointments/{id}/certificates — medical certificates issued
 * for this consultation. The signed-in doctor must own the appointment.
 * `meta.earliest_from_date` is the earliest sick-leave start the POST accepts.
 */
final class ListCertificatesAction
{
    use ApiResponse;
    use ResolvesDoctorAppointment;

    public function __construct(
        private readonly UserRepository $users,
        private readonly AppointmentRepository $appointments,
        private readonly MedicalCertificateRepository $certificates,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
        array $args,
    ): ResponseInterface {
        $id = (string) $args['id'];
        $appointment = $this->doctorAppointment($request, $this->users, $this->appointments, $id);
        if ($appointment === null) {
            return $this->error($response, 'Consultation not found', 403);
        }

        $items = array_map(
            static fn (MedicalCertificate $c): array => $c->toArray(),
            $this->certificates->forAppointment($id),
        );

        // `meta` carries the leave-start floor on the clinic calendar, so the
        // form's picker matches what the POST accepts (the POST still decides).
        return $this->json($response, [
            'status'  => 'success',
            'message' => 'OK',
            'data'    => $items,
            'meta'    => ScheduleRules::certificateWindow(),
        ]);
    }
}
