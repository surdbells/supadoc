<?php

declare(strict_types=1);

namespace App\Action\DoctorApplication\Public;

use App\Action\DoctorApplication\HandlesApplicationRequests;
use App\Infrastructure\Application\DoctorApplicationService;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * DELETE /api/public/doctor-applications/track/info-response/documents/{docId}
 * — remove a document sent in this response (the one it replaced comes
 * back).
 */
final class DeleteInfoDocumentAction
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
        $this->service->deleteInfoDocument($this->applicant($request), (string) ($args['docId'] ?? ''));

        return $this->success($response, ['deleted' => true], 'Document removed');
    }
}
