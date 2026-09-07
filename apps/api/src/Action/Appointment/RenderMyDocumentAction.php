<?php

declare(strict_types=1);

namespace App\Action\Appointment;

use App\Action\Document\RendersClinicalDocument;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\MedicalCertificateRepository;
use App\Domain\Repository\PrescriptionRepository;
use App\Domain\Repository\ReferralRepository;
use App\Infrastructure\Document\ClinicalDocumentRenderer;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/portal/appointments/{id}/documents/{kind}/{docId} — the patient's
 * own prescription, referral, or certificate as a printable document. Scoped by
 * customer_id; unsigned prescriptions are never rendered.
 */
final class RenderMyDocumentAction
{
    use ApiResponse;
    use RendersClinicalDocument;

    public function __construct(
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
        $customerId  = (string) $request->getAttribute('customer_id');
        $id          = (string) $args['id'];
        $kind        = (string) $args['kind'];

        $appointment = $this->appointments->findForPatient($id, $customerId);
        if ($appointment === null) {
            return $this->error($response, 'Appointment not found', 404);
        }

        $record = $this->loadDocument(
            $kind,
            (string) $args['docId'],
            $id,
            true,
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
