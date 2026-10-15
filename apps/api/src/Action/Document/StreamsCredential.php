<?php

declare(strict_types=1);

namespace App\Action\Document;

use App\Domain\Entity\SpecialistCredential;
use Psr\Http\Message\ResponseInterface;

/**
 * Sends a doctor's licensing document (already decrypted) back inline, never
 * cached and never sniffed into another type. The caller has checked who may
 * see it (the doctor, or a reviewer — whose view it audits).
 */
trait StreamsCredential
{
    private function streamCredential(ResponseInterface $response, SpecialistCredential $credential, ?string $bytes): ResponseInterface
    {
        if ($bytes === null) {
            $response->getBody()->write(
                json_encode(['status' => 'error', 'message' => 'This document could not be read. Ask the doctor to upload it again.'], JSON_UNESCAPED_SLASHES),
            );

            return $response->withHeader('Content-Type', 'application/json')->withStatus(404);
        }

        $safeName = preg_replace('/[^A-Za-z0-9._ -]/', '_', $credential->getOriginalName()) ?? 'document';
        $response->getBody()->write($bytes);

        return $response
            ->withHeader('Content-Type', $credential->getMime())
            ->withHeader('Content-Length', (string) strlen($bytes))
            ->withHeader('Content-Disposition', 'inline; filename="' . $safeName . '"')
            ->withHeader('Cache-Control', 'private, no-store')
            ->withHeader('X-Content-Type-Options', 'nosniff');
    }
}
