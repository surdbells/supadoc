<?php

declare(strict_types=1);

namespace App\Action\Document;

use App\Domain\Entity\MedicalDocument;
use App\Infrastructure\Service\MedicalDocumentStorage;
use Psr\Http\Message\ResponseInterface;
use Slim\Psr7\Stream;

/**
 * Streams a stored medical-document file back through the PSR-7 response with the
 * right content type and an inline disposition (so PDFs/images/video preview).
 * The caller has already checked ownership; this only touches the file on disk.
 */
trait StreamsDocument
{
    private function streamDocument(
        ResponseInterface $response,
        MedicalDocumentStorage $storage,
        MedicalDocument $doc,
    ): ResponseInterface {
        $path   = $storage->path($doc);
        $handle = @fopen($path, 'rb');
        if ($handle === false) {
            $response->getBody()->write(
                json_encode(['status' => 'error', 'message' => 'File not found'], JSON_UNESCAPED_SLASHES),
            );

            return $response->withHeader('Content-Type', 'application/json')->withStatus(404);
        }

        $safeName = preg_replace('/[^A-Za-z0-9._ -]/', '_', $doc->getTitle() . '.' . $doc->getExtension()) ?? 'document';

        return $response
            ->withBody(new Stream($handle))
            ->withHeader('Content-Type', $doc->getMimeType())
            ->withHeader('Content-Length', (string) (filesize($path) ?: 0))
            ->withHeader('Content-Disposition', 'inline; filename="' . $safeName . '"')
            ->withHeader('Cache-Control', 'private, no-store')
            ->withHeader('X-Content-Type-Options', 'nosniff');
    }
}
