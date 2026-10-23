<?php

declare(strict_types=1);

namespace App\Action\DoctorApplication\Admin;

use App\Action\DoctorApplication\HandlesApplicationRequests;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Application\ApplicationApprovalService;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/doctor-applications/{id}/approve — create the doctor (invited)
 * with verified documents and email the set-password link. Needs
 * `specialists.manage`.
 */
final class ApproveApplicationAction
{
    use ApiResponse;
    use HandlesApplicationRequests;

    public function __construct(
        private readonly ApplicationApprovalService $approval,
        private readonly UserRepository $users,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
        array $args,
    ): ResponseInterface {
        [$actorId, $actorName] = $this->reviewer($request, $this->users);

        return $this->success($response, $this->approval->approve((string) ($args['id'] ?? ''), $this->body($request), $actorId, $actorName), 'Application approved');
    }
}
