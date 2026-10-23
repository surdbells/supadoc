<?php

declare(strict_types=1);

namespace App\Action\DoctorApplication\Public;

use App\Action\DoctorApplication\HandlesApplicationRequests;
use App\Infrastructure\Application\DoctorApplicationService;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/public/doctor-applications/drafts/current/email-code — a 6-digit
 * code to confirm the email before submit (202; 200 with already_verified).
 * 429 resend_cooldown | rate_limited; 503 codes_unavailable.
 */
final class SendEmailCodeAction
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
        [$status, $data] = $this->service->sendEmailCode($this->applicant($request));

        return $this->success($response, $data, $status === 200 ? 'Email already confirmed' : 'Code sent', $status);
    }
}
