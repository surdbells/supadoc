<?php

declare(strict_types=1);

namespace App\Action\Document;

use App\Domain\Document\DocumentSharingRules;
use App\Domain\Entity\MedicalDocument;
use App\Infrastructure\Service\MedicalDocumentStorage;
use Psr\Http\Message\ResponseInterface;
use Slim\Psr7\Stream;

/**
 * Streams a stored medical-document file back through the PSR-7 response with the
 * right content type and an inline disposition (so PDFs/images/video preview).
 * The caller has already checked ownership; this only touches the file on disk.
 *
 * `$viewOnly` (a doctor's in-app viewer): the fixed Content-Type of the
 * extension (never the sniffed value), `inline` with no file name, no caching
 * of any kind, and a sandboxing CSP — plus the caller's `$extraHeaders` (the
 * view reference). The patient's own download keeps the plain form.
 */
trait StreamsDocument
{
    /** @param array<string,string> $extraHeaders */
    private function streamDocument(
        ResponseInterface $response,
        MedicalDocumentStorage $storage,
        MedicalDocument $doc,
        bool $viewOnly = false,
        array $extraHeaders = [],
    ): ResponseInterface {
        $path   = $storage->path($doc);
        $handle = @fopen($path, 'rb');
        if ($handle === false) {
            $response->getBody()->write(
                json_encode(['status' => 'error', 'message' => 'File not found'], JSON_UNESCAPED_SLASHES),
            );

            return $response->withHeader('Content-Type', 'application/json')->withStatus(404);
        }

        if ($viewOnly) {
            $response = $response
                ->withBody(new Stream($handle))
                ->withHeader('Content-Type', DocumentSharingRules::viewContentType($doc->getExtension()))
                ->withHeader('Content-Length', (string) (filesize($path) ?: 0))
                ->withHeader('Content-Disposition', 'inline')
                ->withHeader('Cache-Control', 'private, no-store, max-age=0')
                ->withHeader('Pragma', 'no-cache')
                ->withHeader('X-Content-Type-Options', 'nosniff')
                ->withHeader('Content-Security-Policy', "default-src 'none'; sandbox")
                ->withHeader('Referrer-Policy', 'no-referrer');
            foreach ($extraHeaders as $name => $value) {
                $response = $response->withHeader($name, $value);
            }

            return $response;
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
