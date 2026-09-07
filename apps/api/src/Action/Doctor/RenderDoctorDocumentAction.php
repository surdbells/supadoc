<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Action\Document\RendersClinicalDocument;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\MedicalCertificateRepository;
use App\Domain\Repository\PrescriptionRepository;
use App\Domain\Repository\ReferralRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Document\ClinicalDocumentRenderer;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/doctor/appointments/{id}/documents/{kind}/{docId} — render a
 * prescription, referral, or certificate as a printable document. The signed-in
 * doctor must own the appointment, and the document must belong to it.
 */
final class RenderDoctorDocumentAction
{
    use ApiResponse;
    use ResolvesDoctorAppointment;
    use RendersClinicalDocument;

    public function __construct(
        private readonly UserRepository $users,
        private readonly AppointmentRepository $appointments,
        private readonly PrescriptionRepository $prescriptions,
        private readonly ReferralRepository $referrals,
        private readonly MedicalCertificateRepository $certificates,
        private readonly ClinicalDocumentRenderer $renderer,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
        array $args,
    ): ResponseInterface {
        $id   = (string) $args['id'];
        $kind = (string) $args['kind'];

        $appointment = $this->doctorAppointment($request, $this->users, $this->appointments, $id);
        if ($appointment === null) {
            return $this->error($response, 'Consultation not found', 403);
        }

        $record = $this->loadDocument(
            $kind,
            (string) $args['docId'],
            $id,
            false,
            $this->prescriptions,
            $this->referrals,
            $this->certificates,
        );
        if ($record === null) {
            return $this->error($response, 'Document not found', 404);
        }

        return $this->renderDocument($response, $this->renderer, $kind, $record, $appointment);
    }
}
