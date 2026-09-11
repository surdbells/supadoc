<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Domain\Entity\MedicalDocument;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\MedicalDocumentRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/doctor/appointments/{id}/patient-documents — every medical document
 * belonging to this consultation's patient, so the doctor can review them in-call
 * without leaving the room. The signed-in doctor must own the appointment.
 */
final class ListPatientDocumentsAction
{
    use ApiResponse;
    use ResolvesDoctorAppointment;

    public function __construct(
        private readonly UserRepository $users,
        private readonly AppointmentRepository $appointments,
        private readonly MedicalDocumentRepository $documents,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
        array $args,
    ): ResponseInterface {
        $appointment = $this->doctorAppointment($request, $this->users, $this->appointments, (string) $args['id']);
        if ($appointment === null) {
            return $this->error($response, 'Consultation not found', 403);
        }

        $items = array_map(
            static fn (MedicalDocument $d): array => $d->toArray(),
            $this->documents->allForPatient($appointment->getPatient()->getId()),
        );

        return $this->success($response, $items)->withHeader('Cache-Control', 'no-store');
    }
}
