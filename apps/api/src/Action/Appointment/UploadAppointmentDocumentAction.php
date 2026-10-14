<?php

declare(strict_types=1);

namespace App\Action\Appointment;

use App\Domain\Document\DocumentType;
use App\Domain\Entity\MedicalDocument;
use App\Domain\Repository\MedicalDocumentRepository;
use App\Domain\Repository\PatientRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\DocumentRejectedException;
use App\Infrastructure\Service\MedicalDocumentStorage;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Message\UploadedFileInterface;

/**
 * POST /api/portal/appointment-documents (multipart, field `document`) — a file
 * the patient attaches while booking (lab report, scan, photo). It is filed in
 * their medical record as a Booking Attachment: stored OUTSIDE the web root by
 * MedicalDocumentStorage (same checks and 10MB cap as POST /portal/documents)
 * and only ever served through the authenticated document routes, so the
 * doctor sees it in the patient's documents too. One file per request; the
 * booking then links up to 10 of them by id (`document_ids`).
 */
final class UploadAppointmentDocumentAction
{
    use ApiResponse;

    public function __construct(
        private readonly PatientRepository $patients,
        private readonly MedicalDocumentRepository $documents,
        private readonly MedicalDocumentStorage $storage,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        $customerId = (string) $request->getAttribute('customer_id');
        $file       = $request->getUploadedFiles()['document'] ?? null;

        if (!$file instanceof UploadedFileInterface || $file->getError() !== UPLOAD_ERR_OK) {
            return $this->error($response, 'No file uploaded', 422, ['document' => 'Attach a file to upload']);
        }

        $patient = $this->patients->find($customerId);
        if ($patient === null) {
            return $this->error($response, 'Account not found', 404);
        }

        try {
            $meta = $this->storage->store($file, $customerId);
        } catch (DocumentRejectedException $e) {
            return $this->error($response, $e->getMessage(), 422, ['document' => $e->getMessage()]);
        } catch (\Throwable $e) {
            // Anything else is a server fault whose message may name server paths: logged, never shown.
            error_log('[appointment-documents] storage failed: ' . $e->getMessage());

            return $this->error($response, 'Could not save the file. Please try again.', 500);
        }

        $p        = $patient->toArray();
        $document = new MedicalDocument(
            $customerId,
            MedicalDocument::UPLOADER_PATIENT,
            trim((string) ($p['first_name'] ?? '') . ' ' . (string) ($p['last_name'] ?? '')) ?: 'Patient',
            DocumentType::BOOKING_ATTACHMENT,
            $meta['title'],
            $meta['stored_name'],
            $meta['mime'],
            $meta['extension'],
            $meta['size'],
        );

        try {
            $this->documents->save($document);
        } catch (\Throwable $e) {
            // Never leave an orphaned file behind a failed metadata write.
            $this->storage->delete($document);
            error_log('[appointment-documents] save failed: ' . $e->getMessage());

            return $this->error($response, 'Could not save the file. Please try again.', 500);
        }

        // `url` is the authenticated download route (bearer token required) —
        // never a public path. Older booking clients send it back as
        // `document_url`, which the booking maps to this document.
        return $this->created(
            $response,
            $document->toArray() + ['url' => '/api/portal/documents/' . $document->getId() . '/file'],
            'Uploaded',
        );
    }
}
