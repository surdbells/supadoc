<?php

declare(strict_types=1);

namespace App\Action\DocumentSharing;

use App\Domain\Document\DocumentSharingRules as Rules;
use App\Domain\Entity\Patient;
use App\Domain\Repository\PatientRepository;
use App\Infrastructure\Document\DocumentSharingService;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/portal/document-access/requests/{id}/approve
 * (ApproveAccessRequestInput) — approve with the chosen scope and duration:
 * the request closes `approved` and the share is made in one transaction.
 * 409 `request_not_pending` (+ `errors.status`) when it was already answered,
 * withdrawn or closed; 422 `doctor_unavailable` / `doctor_not_eligible` when
 * the doctor can't be shared with any more (the request is then closed).
 * The doctor is told "approved". `{request, grant}`.
 */
final class ApproveAccessRequestAction
{
    use ApiResponse;
    use SharingActionSupport;

    public function __construct(
        private readonly PatientRepository $patients,
        private readonly DocumentSharingService $sharing,
    ) {
    }

    public function __invoke(ServerRequestInterface $request, ResponseInterface $response, array $args): ResponseInterface
    {
        return $this->forPatient($request, $response, $this->patients, fn (Patient $p): ResponseInterface =>
            $this->success($response, $this->sharing->approveRequest($p, (string) $args['id'], $this->body($request), Rules::now()), 'Approved'));
    }
}
