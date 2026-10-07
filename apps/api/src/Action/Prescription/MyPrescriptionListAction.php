<?php

declare(strict_types=1);

namespace App\Action\Prescription;

use App\Domain\Entity\Prescription;
use App\Domain\Repository\PrescriptionRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/portal/prescriptions — the signed-in patient's prescriptions
 * (Consultation History › Prescriptions): number, doctor, date sent, valid
 * until and status (active / expired / cancelled), newest first. Never drafts.
 */
final class MyPrescriptionListAction
{
    use ApiResponse;

    public function __construct(private readonly PrescriptionRepository $prescriptions)
    {
    }

    public function __invoke(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $customerId = (string) $request->getAttribute('customer_id');
        $rows       = array_map(
            static fn (Prescription $rx): array => $rx->toSummaryArray(),
            $this->prescriptions->sentForPatient($customerId),
        );

        return $this->success($response, $rows)->withHeader('Cache-Control', 'no-store');
    }
}
