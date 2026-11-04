<?php

declare(strict_types=1);

namespace App\Action\LabRequest\Admin;

use App\Action\LabRequest\LabActionSupport;
use App\Domain\Entity\User;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Lab\LabRequestService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/admin/lab-requests/{labId}/status {status, reason, sample_date?}
 * (`labs.manage`) — support corrects a patient-reported status (booked ↔ in
 * lab, reopen a declined or expired request). The reason (5–500) is kept
 * with the request for `labs.manage` staff only; the audit row says only
 * that one was given. 422 `status` / `reason` / `sample_date`, 409
 * `status_changed` on a race. 200 the updated summary row "Status updated".
 */
final class CorrectLabRequestStatusAction
{
    use LabActionSupport;

    public function __construct(
        private readonly UserRepository $users,
        private readonly LabRequestService $service,
    ) {
    }

    public function __invoke(ServerRequestInterface $request, ResponseInterface $response, array $args): ResponseInterface
    {
        $staff = $this->users->find((string) $request->getAttribute('user_id'));
        if (!$staff instanceof User) {
            return $this->noStore($this->error($response, 'Insufficient permissions', 403));
        }
        try {
            $row = $this->service->correct($staff, (string) $args['labId'], $this->body($request));
        } catch (\Throwable $e) {
            return $this->refused($response, $e);
        }

        return $this->noStore($this->success($response, $row, 'Status updated'));
    }
}
