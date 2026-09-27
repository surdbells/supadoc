<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Domain\Entity\Prescription;
use App\Domain\Enum\NotificationType;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\PrescriptionRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\AuditLogger;
use App\Infrastructure\Service\PatientNotifier;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/doctor/appointments/{id}/prescriptions — build and issue (sign) an
 * e-prescription for the consultation. Requires at least one medication line;
 * the issued prescription becomes visible to the patient and is audited.
 */
final class CreatePrescriptionAction
{
    use ApiResponse;
    use ResolvesDoctorAppointment;

    public function __construct(
        private readonly UserRepository $users,
        private readonly AppointmentRepository $appointments,
        private readonly PrescriptionRepository $prescriptions,
        private readonly AuditLogger $audit,
        private readonly PatientNotifier $patientNotifier,
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

        $body  = (array) ($request->getParsedBody() ?? []);
        $items = is_array($body['items'] ?? null) ? $body['items'] : [];

        $prescription = new Prescription($id, $appointment->getPatient()->getId());
        $prescription->setItems($items);
        if ($prescription->getItems() === []) {
            return $this->error($response, 'Add at least one medication', 422);
        }
        $prescription->setNotes(is_string($body['notes'] ?? null) ? $body['notes'] : null);

        $author = $appointment->getSpecialist()->getName();
        $prescription->sign($author);
        $this->prescriptions->save($prescription);

        $this->audit->record(
            $author,
            'doctor',
            'prescription.signed',
            $id,
            'prescription',
            $prescription->getId(),
            ['items' => count($prescription->getItems())],
        );

        $this->patientNotifier->notify(
            $appointment->getPatient(),
            NotificationType::PRESCRIPTION,
            'New prescription',
            'A new prescription from ' . $author . ' is now available in your documents.',
        );

        return $this->success($response, $prescription->toArray(), 'Prescription issued', 201)
            ->withHeader('Cache-Control', 'no-store');
    }
}
