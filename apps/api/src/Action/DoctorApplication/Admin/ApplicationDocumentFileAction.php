<?php

declare(strict_types=1);

namespace App\Action\DoctorApplication\Admin;

use App\Action\DoctorApplication\HandlesApplicationRequests;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Application\ApplicationReviewService;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/doctor-applications/{id}/documents/{docId}/file — the document,
 * inline; every view is audited. Needs `specialists.manage`.
 */
final class ApplicationDocumentFileAction
{
    use ApiResponse;
    use HandlesApplicationRequests;

    public function __construct(
        private readonly ApplicationReviewService $review,
        private readonly UserRepository $users,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
        array $args,
    ): ResponseInterface {
        [$actorId, $actorName] = $this->reviewer($request, $this->users);
        [$doc, $bytes]         = $this->review->documentFile((string) ($args['id'] ?? ''), (string) ($args['docId'] ?? ''), $actorId, $actorName);

        return $this->streamDocument($response, $doc, $bytes);
    }
}
