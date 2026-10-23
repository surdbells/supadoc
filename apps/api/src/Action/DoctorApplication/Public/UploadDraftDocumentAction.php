<?php

declare(strict_types=1);

namespace App\Action\DoctorApplication\Public;

use App\Action\DoctorApplication\HandlesApplicationRequests;
use App\Infrastructure\Application\DoctorApplicationService;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/public/doctor-applications/drafts/current/documents (multipart
 * `slot` + `file`) — PDF, PNG or JPG up to 5MB; replaces the slot's
 * document. 422 file_invalid | upload_limit | upload_slot_invalid; 503
 * storage_unavailable.
 */
final class UploadDraftDocumentAction
{
    use ApiResponse;
    use HandlesApplicationRequests;

    public function __construct(private readonly DoctorApplicationService $service)
    {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        [$fields, $file] = $this->multipart($request);
        if ($file === null) {
            return $this->error($response, 'Attach the document', 422, ['file' => 'Upload a PDF, PNG or JPG file.', 'code' => 'file_invalid']);
        }

        return $this->created($response, $this->service->uploadDraftDocument($this->applicant($request), (string) ($fields['slot'] ?? ''), $file), 'Document uploaded');
    }
}
