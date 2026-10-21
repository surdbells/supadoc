<?php

declare(strict_types=1);

namespace App\Action\Patient;

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
use App\Infrastructure\Service\MedicalDocumentStorage;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Message\UploadedFileInterface;

/**
 * POST /api/portal/documents (multipart) — the patient files a document into
 * their medical record. Fields: `file`, `document_type`, optional `custom_type`
 * (required when the type is `other`). Bytes are stored outside the web root.
 *
 * Who can see it (spec §3.3; nothing is shared silently) — optional fields:
 *  - `share_specialist_ids[]` (≤ 5 booked, practising doctors) with
 *    `share_duration`, `share_expires_at` (`until`), `share_appointment_id`
 *    (always validated; required for `after_*`) and `share_batch_id` (one per
 *    upload batch: the batch's files go on one share);
 *  - `exclude_specialist_ids[]` (≤ 20 booked doctors): doctors with a
 *    whole-folder share who must NOT see this file (may come alone);
 *  - `share_surface`: documents_page (default) | appointment_details.
 * Without them the file is private — except to doctors holding a whole-folder
 * share (folder semantics, shown to the patient before they upload).
 *
 * The sharing fields and the batch are checked BEFORE the bytes are stored
 * (409 `idempotency_conflict` when this batch id was sent with other choices);
 * the document row and its sharing are then written in one pair-locked
 * transaction — a refusal or failure there deletes the stored bytes. 201
 * UploadedDocumentDto: `shared_with`, `share_outcome` (shared | partly_shared
 * | share_ended | private | sharing_unavailable) and `share_ended_for` (the
 * doctors whose batch share had already ended, so they can't see this file).
 */
final class UploadMyDocumentAction
{
    use ApiResponse;

    /** Length of medical_documents.custom_type. */
    public const CUSTOM_TYPE_MAX = 120;

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
        // Multipart text fields: the parsed body is populated from $_POST by the
        // request factory; fall back to $_POST directly in case it wasn't.
        $body = $request->getParsedBody();
        if (!is_array($body) || $body === []) {
            $body = $_POST;
        }

        $type = (string) ($body['document_type'] ?? '');
        if (!DocumentType::isValid($type)) {
            return $this->error($response, 'Choose a document type', 422, ['document_type' => 'Select a valid document type']);
        }
        $customType = is_string($body['custom_type'] ?? null) ? trim((string) $body['custom_type']) : '';
        if ($type === 'other' && $customType === '') {
            return $this->error($response, 'Specify the document type', 422, ['custom_type' => 'Please name the document type']);
        }
        // medical_documents.custom_type is VARCHAR(120): reject here with a 422
        // rather than letting the INSERT fail as a 500. Only checked for `other`,
        // the one type that stores it — an ignored value shouldn't block upload.
        if ($type === 'other' && mb_strlen($customType) > self::CUSTOM_TYPE_MAX) {
            return $this->error($response, 'Document type name is too long', 422, [
                'custom_type' => 'Use ' . self::CUSTOM_TYPE_MAX . ' characters or fewer',
            ]);
        }

        $file = $request->getUploadedFiles()['file'] ?? null;
        if (!$file instanceof UploadedFileInterface) {
            return $this->error($response, 'No file uploaded', 422, ['file' => 'Attach a file']);
        }

        $patient = $this->patients->find($customerId);
        if (!$patient instanceof Patient) {
            return $this->error($response, 'Account not found', 404);
        }

        // Sharing choices and the batch: refused before a byte is stored.
        $now = Rules::now();
        try {
            $choice = $this->sharing->validateUploadShare($patient, $body, $now);
        } catch (DomainRefusal $r) {
            return $this->error($response, $r->getMessage(), $r->status, $r->errors);
        }

        try {
            $meta = $this->storage->store($file, $customerId);
        } catch (\RuntimeException $e) {
            return $this->error($response, $e->getMessage(), 422, ['file' => $e->getMessage()]);
        } catch (\Throwable $e) {
            error_log('[documents.upload] storage failed: ' . $e->getMessage());

            return $this->error($response, 'Could not process the file. Please try again.', 500);
        }

        $p          = $patient->toArray();
        $uploaderNm = trim((string) ($p['first_name'] ?? '') . ' ' . (string) ($p['last_name'] ?? '')) ?: 'Patient';

        $document = new MedicalDocument(
            $customerId,
            MedicalDocument::UPLOADER_PATIENT,
            $uploaderNm,
            $type,
            $meta['title'],
            $meta['stored_name'],
            $meta['mime'],
            $meta['extension'],
            $meta['size'],
        );
        if ($type === 'other') {
            $document->setCustomType($customType);
        }

        try {
            $result = $this->sharing->shareUpload($patient, $document, $choice['share'], $choice['exclude'], $now);
        } catch (DomainRefusal $r) {
            // Refused inside the locks (e.g. the doctor stopped practising a moment ago): nothing kept.
            $this->storage->delete($document);

            return $this->error($response, $r->getMessage(), $r->status, $r->errors);
        } catch (\Throwable $e) {
            // Don't leave an orphaned file if the metadata row can't be written
            // (e.g. the medical_documents table hasn't been migrated yet).
            $this->storage->delete($document);
            error_log('[documents.upload] save failed (has the schema been applied?): ' . $e::class . ': ' . $e->getMessage());

            return $this->error($response, 'Could not save the document. Please try again.', 500);
        }

        $outcome = match (true) {
            !$choice['asked']           => 'private',
            !Rules::enabled()           => 'sharing_unavailable',
            $result['ended_for'] === [] => 'shared',
            $result['shared'] === []    => 'share_ended',
            default                     => 'partly_shared',
        };

        return $this->created(
            $response,
            DocumentSharingPresenter::uploaded($document, $this->sharedWith($patient, $document, $now), $outcome, $result['ended_for']),
            'Document uploaded',
        );
    }

    /** Who can see the new file now (empty when that can't be worked out: the upload itself succeeded). */
    private function sharedWith(Patient $patient, MedicalDocument $document, \DateTimeImmutable $now): array
    {
        try {
            return $this->views->sharedWith($patient, [$document->getId()], $now)[strtolower($document->getId())] ?? [];
        } catch (\Throwable $e) {
            error_log('[doc-access] upload shared_with failed: ' . $e::class . ': ' . $e->getMessage());

            return [];
        }
    }
}
