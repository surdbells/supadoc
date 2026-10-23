<?php

declare(strict_types=1);

namespace App\Action\DoctorApplication\Public;

use App\Action\DoctorApplication\HandlesApplicationRequests;
use App\Infrastructure\Application\DoctorApplicationService;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/public/doctor-applications/track/info-response/submit — send the
 * requested items; the review resumes. 422 incomplete.
 */
final class SubmitInfoResponseAction
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
        return $this->success($response, $this->service->submitInfoResponse($this->applicant($request), $this->body($request)), 'Thanks — your review has resumed.');
    }
}
