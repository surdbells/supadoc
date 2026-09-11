<?php

declare(strict_types=1);

namespace App\Action\Patient;

use App\Domain\Document\DocumentType;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/portal/document-types — the medical-document type catalogue that
 * drives the upload dropdown. Server-owned so the list can never drift from what
 * the upload endpoint accepts.
 */
final class DocumentTypesAction
{
    use ApiResponse;

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        return $this->success($response, DocumentType::all());
    }
}
