<?php

declare(strict_types=1);

namespace App\Action\Appointment;

use App\Domain\Document\DocumentSharingRules as Rules;
use App\Domain\Document\DocumentType;
use App\Domain\Document\DomainRefusal;
use App\Domain\Entity\MedicalDocument;
use App\Domain\Entity\Patient;
use App\Domain\Repository\PatientRepository;
use App\Infrastructure\Document\DocumentSharingPresenter;
use App\Infrastructure\Document\DocumentSharingService;
use App\Infrastructure\Document\DocumentSharingViews;
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
 * and only ever served through the authenticated document routes. One file per
 * request; the booking then links up to 10 of them by id (`document_ids`).
 *
 * Private by default (spec §3.3): the file is HIDDEN from every doctor who
 * holds a whole-folder share — the doctor being booked included — except the
 * doctors listed in the optional `show_specialist_ids[]` (≤ 20 doctors the
 * patient booked: "Also let Dr X see these files"). An older client sends
 * nothing, so its attachments are hidden from all of them. Whether the booked
 * doctor sees them is the booking's own `document_share` choice. The hidden
 * rows are written whether or not sharing is switched on, so turning it on
 * later never exposes the file. The answer adds `shared_with` (who can see it
 * now), `share_outcome` and `share_ended_for`.
 */
final class UploadAppointmentDocumentAction
{
    use ApiResponse;

    public function __construct(
        private readonly PatientRepository $patients,
        private readonly MedicalDocumentStorage $storage,
        private readonly DocumentSharingService $sharing,
        private readonly DocumentSharingViews $views,
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
        if (!$patient instanceof Patient) {
            return $this->error($response, 'Account not found', 404);
        }

        $body = $request->getParsedBody();
        if (!is_array($body) || $body === []) {
            $body = $_POST;
        }
        try {
            $show = $this->sharing->validateShowIds($patient, $body['show_specialist_ids'] ?? null);
        } catch (DomainRefusal $r) {
            return $this->error($response, $r->getMessage(), $r->status, $r->errors);
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

        $now = Rules::now();
        try {
            // The row and its hidden rows in one pair-locked transaction.
            $this->sharing->hideBookingAttachment($patient, $document, $show, $now);
        } catch (\Throwable $e) {
            // Never leave an orphaned file behind a failed metadata write.
            $this->storage->delete($document);
            error_log('[appointment-documents] save failed: ' . $e::class . ': ' . $e->getMessage());

            return $this->error($response, 'Could not save the file. Please try again.', 500);
        }

        try {
            $sharedWith = $this->views->sharedWith($patient, [$document->getId()], $now)[strtolower($document->getId())] ?? [];
        } catch (\Throwable $e) {
            error_log('[doc-access] attachment shared_with failed: ' . $e::class . ': ' . $e->getMessage());
            $sharedWith = [];
        }

        // `url` is the authenticated download route (bearer token required) —
        // never a public path. Older booking clients send it back as
        // `document_url`, which the booking maps to this document.
        return $this->created(
            $response,
            DocumentSharingPresenter::uploaded($document, $sharedWith, 'private', [])
                + ['url' => '/api/portal/documents/' . $document->getId() . '/file'],
            'Uploaded',
        );
    }
}
