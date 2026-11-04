<?php

declare(strict_types=1);

namespace App\Action\LabRequest\Admin;

use App\Action\LabRequest\LabActionSupport;
use App\Domain\Document\DomainRefusal;
use App\Domain\Lab\LabRequestRules;
use App\Domain\Repository\LabRequestRepository;
use App\Infrastructure\Lab\LabRequestService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/admin/lab-requests/{labId}/link {download?} (`labs.manage`) — a
 * 15-minute signed URL to a request PDF for support staff; the file fetch is
 * audited and re-checks that the user still holds `labs.manage`.
 * Rate-limited (`lab-link`).
 */
final class AdminLabRequestLinkAction
{
    use LabActionSupport;

    public function __construct(
        private readonly LabRequestRepository $requests,
        private readonly LabRequestService $service,
    ) {
    }

    public function __invoke(ServerRequestInterface $request, ResponseInterface $response, array $args): ResponseInterface
    {
        $r = $this->requests->findById((string) $args['labId']);
        if ($r === null) {
            return $this->refused($response, DomainRefusal::notFound(LabRequestRules::NOT_FOUND));
        }
        $download = filter_var($this->body($request)['download'] ?? false, FILTER_VALIDATE_BOOLEAN);

        return $this->noStore($this->success($response, $this->service->issueLink($r, 'staff', (string) $request->getAttribute('user_id'), $download)));
    }
}
