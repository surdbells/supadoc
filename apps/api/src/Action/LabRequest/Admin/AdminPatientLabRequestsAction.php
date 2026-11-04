<?php

declare(strict_types=1);

namespace App\Action\LabRequest\Admin;

use App\Action\LabRequest\LabActionSupport;
use App\Infrastructure\Lab\LabRequestService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/admin/patients/{id}/lab-requests (`monitoring.view`) — a patient's
 * lab requests, newest first, as summary rows WITHOUT clinical content
 * (AdminLabRequestSummaryDto): status, priority, doctor, counts, the
 * corrections staff may make and the clinic date of consent. The latest
 * correction's note is returned only to `labs.manage` holders (else null).
 */
final class AdminPatientLabRequestsAction
{
    use LabActionSupport;

    public function __construct(private readonly LabRequestService $service)
    {
    }

    public function __invoke(ServerRequestInterface $request, ResponseInterface $response, array $args): ResponseInterface
    {
        return $this->noStore($this->success($response, $this->service->adminRows((string) $args['id'], self::managesLabs($request))));
    }

    /** `labs.manage` in the token (or super_admin). */
    public static function managesLabs(ServerRequestInterface $request): bool
    {
        return in_array('super_admin', (array) $request->getAttribute('user_roles', []), true)
            || in_array('labs.manage', (array) $request->getAttribute('user_permissions', []), true);
    }
}
