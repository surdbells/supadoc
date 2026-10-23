<?php

declare(strict_types=1);

namespace App\Action\DoctorApplication\Public;

use App\Action\DoctorApplication\HandlesApplicationRequests;
use App\Infrastructure\Application\DoctorApplicationService;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * PUT /api/public/doctor-applications/track/info-response/sections/{section}
 * — update a section the team asked for. 403 item_not_requested; 409
 * not_allowed.
 */
final class SaveInfoSectionAction
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
        return $this->success($response, $this->service->saveInfoSection($this->applicant($request), (string) ($args['section'] ?? ''), $this->body($request)), 'Updated');
    }
}
