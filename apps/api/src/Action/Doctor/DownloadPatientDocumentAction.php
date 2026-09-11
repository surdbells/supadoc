<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Action\Document\StreamsDocument;
use App\Domain\Entity\MedicalDocument;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\MedicalDocumentRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\MedicalDocumentStorage;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/doctor/appointments/{id}/patient-documents/{docId}/file — stream one
 * of the consultation patient's documents. The doctor must own the appointment
 * and the document must belong to that appointment's patient.
 */
final class DownloadPatientDocumentAction
{
    use ApiResponse;
    use ResolvesDoctorAppointment;
    use StreamsDocument;

    public function __construct(
        private readonly UserRepository $users,
        private readonly AppointmentRepository $appointments,
        private readonly MedicalDocumentRepository $documents,
        private readonly MedicalDocumentStorage $storage,
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

        $doc = $this->documents->find((string) $args['docId']);
        if (!$doc instanceof MedicalDocument || $doc->getPatientId() !== $appointment->getPatient()->getId()) {
            return $this->error($response, 'Document not found', 404);
        }

        return $this->streamDocument($response, $this->storage, $doc);
    }
}
