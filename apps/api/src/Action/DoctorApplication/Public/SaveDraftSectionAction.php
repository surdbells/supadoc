<?php

declare(strict_types=1);

namespace App\Action\DoctorApplication\Public;

use App\Action\DoctorApplication\HandlesApplicationRequests;
use App\Infrastructure\Application\DoctorApplicationService;
use App\Infrastructure\Http\TrustedClientIp;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * PUT /api/public/doctor-applications/drafts/current/sections/{section} —
 * save one section (`partial` for Save & continue later). 422 with field
 * errors; 409 consent_outdated.
 */
final class SaveDraftSectionAction
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
        return $this->success($response, $this->service->saveSection(
            $this->applicant($request),
            (string) ($args['section'] ?? ''),
            $this->body($request),
            TrustedClientIp::from($request),
            $request->getHeaderLine('User-Agent'),
        ), 'Saved');
    }
}
