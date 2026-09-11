<?php

declare(strict_types=1);

namespace App\Action\Patient;

use App\Action\Document\StreamsDocument;
use App\Domain\Entity\MedicalDocument;
use App\Domain\Repository\MedicalDocumentRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\MedicalDocumentStorage;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/portal/documents/{id}/file — stream one of the patient's own
 * documents. Scoped by customer_id, so another patient's id 404s.
 */
final class DownloadMyDocumentAction
{
    use ApiResponse;
    use StreamsDocument;

    public function __construct(
        private readonly MedicalDocumentRepository $documents,
        private readonly MedicalDocumentStorage $storage,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
        array $args,
    ): ResponseInterface {
        $customerId = (string) $request->getAttribute('customer_id');
        $doc        = $this->documents->find((string) $args['id']);
        if (!$doc instanceof MedicalDocument || $doc->getPatientId() !== $customerId) {
            return $this->error($response, 'Document not found', 404);
        }

        return $this->streamDocument($response, $this->storage, $doc);
    }
}
