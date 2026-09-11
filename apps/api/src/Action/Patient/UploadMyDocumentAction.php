<?php

declare(strict_types=1);

namespace App\Action\Patient;

use App\Domain\Document\DocumentType;
use App\Domain\Entity\MedicalDocument;
use App\Domain\Repository\MedicalDocumentRepository;
use App\Domain\Repository\PatientRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\MedicalDocumentStorage;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Message\UploadedFileInterface;

/**
 * POST /api/portal/documents (multipart) — the patient files a document into
 * their medical record. Fields: `file`, `document_type`, optional `custom_type`
 * (required when the type is `other`). Bytes are stored outside the web root.
 */
final class UploadMyDocumentAction
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
        $body       = (array) ($request->getParsedBody() ?? []);

        $type = (string) ($body['document_type'] ?? '');
        if (!DocumentType::isValid($type)) {
            return $this->error($response, 'Choose a document type', 422, ['document_type' => 'Select a valid document type']);
        }
        $customType = is_string($body['custom_type'] ?? null) ? trim((string) $body['custom_type']) : '';
        if ($type === 'other' && $customType === '') {
            return $this->error($response, 'Specify the document type', 422, ['custom_type' => 'Please name the document type']);
        }

        $file = $request->getUploadedFiles()['file'] ?? null;
        if (!$file instanceof UploadedFileInterface) {
            return $this->error($response, 'No file uploaded', 422, ['file' => 'Attach a file']);
        }

        $patient = $this->patients->find($customerId);
        if ($patient === null) {
            return $this->error($response, 'Account not found', 404);
        }

        try {
            $meta = $this->storage->store($file, $customerId);
        } catch (\RuntimeException $e) {
            return $this->error($response, $e->getMessage(), 422, ['file' => $e->getMessage()]);
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
        $this->documents->save($document);

        return $this->created($response, $document->toArray(), 'Document uploaded');
    }
}
