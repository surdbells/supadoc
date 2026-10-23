<?php

declare(strict_types=1);

namespace App\Action\DoctorApplication\Public;

use App\Action\DoctorApplication\HandlesApplicationRequests;
use App\Infrastructure\Application\DoctorApplicationService;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * DELETE /api/public/doctor-applications/drafts/current/documents/{docId} —
 * remove a document from the draft (404 when it isn't this draft's).
 */
final class DeleteDraftDocumentAction
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
        $this->service->deleteDraftDocument($this->applicant($request), (string) ($args['docId'] ?? ''));

        return $this->success($response, ['deleted' => true], 'Document removed');
    }
}
