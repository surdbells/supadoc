<?php

declare(strict_types=1);

namespace App\Action\DoctorApplication\Public;

use App\Action\DoctorApplication\HandlesApplicationRequests;
use App\Infrastructure\Application\DoctorApplicationService;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/public/doctor-applications/drafts/current/submit — submit
 * (idempotent: a replay answers 200 with the same reference). 422 incomplete;
 * 409 email_unverified | duplicate_open_application | already_registered |
 * consent_outdated.
 */
final class SubmitDraftAction
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
        return $this->success($response, $this->service->submit($this->applicant($request)), 'Application submitted');
    }
}
