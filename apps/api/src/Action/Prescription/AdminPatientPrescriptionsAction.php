<?php

declare(strict_types=1);

namespace App\Action\Prescription;

use App\Domain\Repository\PrescriptionRepository;
use App\Infrastructure\Prescription\PrescriptionService;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/admin/patients/{id}/prescriptions — a patient's sent prescriptions
 * for authorised back-office staff (`monitoring.view`). Summary rows only; the
 * file itself is opened through a signed, audited link.
 */
final class AdminPatientPrescriptionsAction
{
    use ApiResponse;

    public function __construct(
        private readonly PrescriptionRepository $prescriptions,
        private readonly PrescriptionService $service,
    ) {
    }

    public function __invoke(ServerRequestInterface $request, ResponseInterface $response, array $args): ResponseInterface
    {
        $rows = $this->service->rowsFor($this->prescriptions->sentForPatient((string) $args['id']));

        return $this->success($response, $rows)->withHeader('Cache-Control', 'no-store');
    }
}
