<?php

declare(strict_types=1);

namespace App\Action\Document;

use App\Domain\Entity\Appointment;
use App\Domain\Entity\MedicalCertificate;
use App\Domain\Entity\Referral;
use App\Domain\Repository\MedicalCertificateRepository;
use App\Domain\Repository\PrescriptionRepository;
use App\Domain\Repository\ReferralRepository;
use App\Infrastructure\Document\ClinicalDocumentPdfRenderer;
use App\Infrastructure\Document\ClinicalDocumentRenderer;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * Loads a clinical document record (referral / certificate), checks it belongs
 * to the appointment, and renders it: as a printable HTML document (the
 * default, kept for tabs opened before the document viewer), or with
 * `?format=pdf` as the A4 PDF the viewer shows. Shared by the doctor and
 * patient document endpoints. Prescriptions are not served here (PDF only,
 * through signed links).
 */
trait RendersClinicalDocument
{
    use BuildsDocumentContext;

    // Prescriptions are deliberately absent: they are served only as the
    // branded PDF through signed, audited links (PrescriptionFileAction), which
    // stamps DRAFT / EXPIRED / CANCELLED.
    private const DOCUMENT_KINDS = ['referral', 'certificate'];

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
        if (!in_array($kind, self::DOCUMENT_KINDS, true)) {
            return null; // includes 'prescription' — PDF only (see DOCUMENT_KINDS)
        }
        switch ($kind) {
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

    /** `?format=pdf` (exactly) asks for the PDF; anything else, or nothing, keeps the HTML. */
    private function documentFormat(ServerRequestInterface $request): string
    {
        return ($request->getQueryParams()['format'] ?? 'html') === 'pdf' ? 'pdf' : 'html';
    }

    /**
     * The render context, the same for both formats: the letterhead (patient,
     * doctor, consultation), the record's own fields, its reference and its
     * issue time, stamped in the issuing doctor's zone.
     *
     * @return array<string,mixed>
     */
    private function clinicalContext(object $record, Appointment $appointment): array
    {
        /** @var array<string,mixed> $data */
        $data      = $record->toArray();
        $issuedAt  = (string) ($data['signed_at'] ?? $data['created_at'] ?? '');

        return array_merge(
            $this->documentContext($appointment),
            $data,
            [
                'document_no'     => (string) ($data['id'] ?? ''),
                'issued_at'       => $issuedAt,
                // The issuing doctor's zone: the issue time is stamped in it.
                'doctor_timezone' => $appointment->getSpecialist()->timeZone()->getName(),
            ],
        );
    }

    /**
     * Write the document to the response: the HTML (unchanged), or with
     * `$format === 'pdf'` the PDF with a no-store, sandboxed, inline answer.
     */
    private function renderDocument(
        ResponseInterface $response,
        ClinicalDocumentRenderer $renderer,
        ClinicalDocumentPdfRenderer $pdfRenderer,
        string $kind,
        object $record,
        Appointment $appointment,
        string $format = 'html',
    ): ResponseInterface {
        $ctx = $this->clinicalContext($record, $appointment);

        if ($format === 'pdf') {
            $pdf = $pdfRenderer->render($kind, $ctx);
            $response->getBody()->write($pdf);

            return $response
                ->withHeader('Content-Type', 'application/pdf')
                ->withHeader('Content-Length', (string) strlen($pdf))
                ->withHeader('Content-Disposition', 'inline; filename="' . $pdfRenderer->filename($kind, $ctx) . '"')
                ->withHeader('Cache-Control', 'private, no-store, max-age=0')
                ->withHeader('Pragma', 'no-cache')
                ->withHeader('X-Content-Type-Options', 'nosniff')
                ->withHeader('Content-Security-Policy', "default-src 'none'; sandbox")
                ->withHeader('Referrer-Policy', 'no-referrer');
        }

        $html = $renderer->render($kind, $ctx);
        $response->getBody()->write($html);

        return $response
            ->withHeader('Content-Type', 'text/html; charset=utf-8')
            ->withHeader('Cache-Control', 'no-store')
            ->withHeader('X-Content-Type-Options', 'nosniff');
    }
}
