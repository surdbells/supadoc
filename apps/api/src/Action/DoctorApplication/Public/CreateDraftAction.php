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
 * POST /api/public/doctor-applications/drafts — create a draft from step 1
 * (201): the draft token, the draft, and the masked address the resume email
 * goes to (sent after the response, within the mail cap). Never mentions other
 * drafts or applications for the email.
 */
final class CreateDraftAction
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
        return $this->created($response, $this->service->createDraft($this->body($request), TrustedClientIp::from($request), $request->getHeaderLine('User-Agent')), 'Application saved');
    }
}
