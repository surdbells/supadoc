<?php

declare(strict_types=1);

namespace App\Action\DoctorApplication\Public;

use App\Action\DoctorApplication\HandlesApplicationRequests;
use App\Infrastructure\Application\DoctorApplicationService;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/public/doctor-applications/track/documents/{docId}/file — one of
 * the application's active documents, inline.
 */
final class TrackDocumentFileAction
{
    use ApiResponse;
    use HandlesApplicationRequests;

    public function __construct(private readonly DoctorApplicationService $service)
    {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
        array $args,
    ): ResponseInterface {
        [$doc, $bytes] = $this->service->documentFile($this->applicant($request), (string) ($args['docId'] ?? ''), true);

        return $this->streamDocument($response, $doc, $bytes);
    }
}
