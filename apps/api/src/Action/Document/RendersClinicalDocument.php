<?php

declare(strict_types=1);

namespace App\Action\Document;

use App\Domain\Entity\Appointment;
use App\Domain\Entity\MedicalCertificate;
use App\Domain\Entity\Prescription;
use App\Domain\Entity\Referral;
use App\Domain\Repository\MedicalCertificateRepository;
use App\Domain\Repository\PrescriptionRepository;
use App\Domain\Repository\ReferralRepository;
use App\Infrastructure\Document\ClinicalDocumentRenderer;
use Psr\Http\Message\ResponseInterface;

/**
 * Loads a clinical document record (prescription / referral / certificate),
 * checks it belongs to the appointment, and renders it as a printable HTML
 * document. Shared by the doctor and patient document endpoints.
 */
trait RendersClinicalDocument
{
    use BuildsDocumentContext;

    private const DOCUMENT_KINDS = ['prescription', 'referral', 'certificate'];

    /**
     * Fetch the record for `$kind`/`$docId` scoped to `$appointmentId`.
     * In patient view, unsigned prescriptions are hidden. Returns null when the
     * kind is unknown, the record is missing, belongs to another appointment, or
     * is not yet visible.
     */
    private function loadDocument(
        string $kind,
        string $docId,
        string $appointmentId,
        bool $patientView,
        PrescriptionRepository $prescriptions,
        ReferralRepository $referrals,
        MedicalCertificateRepository $certificates,
    ): ?object {
        switch ($kind) {
            case 'prescription':
                $r = $prescriptions->find($docId);
                if (!$r instanceof Prescription || $r->getAppointmentId() !== $appointmentId) {
                    return null;
                }
                if ($patientView && !$r->isSigned()) {
                    return null;
                }

                return $r;
            case 'referral':
                $r = $referrals->find($docId);

                return $r instanceof Referral && $r->getAppointmentId() === $appointmentId ? $r : null;
            case 'certificate':
                $r = $certificates->find($docId);

                return $r instanceof MedicalCertificate && $r->getAppointmentId() === $appointmentId ? $r : null;
            default:
                return null;
        }
    }

    /** Build the render context and write the document HTML to the response. */
    private function renderDocument(
        ResponseInterface $response,
        ClinicalDocumentRenderer $renderer,
        string $kind,
        object $record,
        Appointment $appointment,
    ): ResponseInterface {
        /** @var array<string,mixed> $data */
        $data      = $record->toArray();
        $issuedAt  = (string) ($data['signed_at'] ?? $data['created_at'] ?? '');
        $ctx       = array_merge(
            $this->documentContext($appointment),
            $data,
            ['document_no' => (string) ($data['id'] ?? ''), 'issued_at' => $issuedAt],
        );

        $html = $renderer->render($kind, $ctx);
        $response->getBody()->write($html);

        return $response
            ->withHeader('Content-Type', 'text/html; charset=utf-8')
            ->withHeader('Cache-Control', 'no-store')
            ->withHeader('X-Content-Type-Options', 'nosniff');
    }
}
