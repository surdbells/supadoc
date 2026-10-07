<?php

declare(strict_types=1);

namespace App\Action\Prescription;

use App\Domain\Repository\PrescriptionRepository;
use App\Infrastructure\Prescription\PrescriptionService;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/portal/prescriptions/{id}/link — {download?} a signed URL (valid
 * for the admin-set minutes, 15 by default) to view, download or print the
 * branded PDF; the file is named after the prescription number.
 */
final class MyPrescriptionLinkAction
{
    use ApiResponse;

    public function __construct(
        private readonly PrescriptionRepository $prescriptions,
        private readonly PrescriptionService $service,
    ) {
    }

    public function __invoke(ServerRequestInterface $request, ResponseInterface $response, array $args): ResponseInterface
    {
        $customerId = (string) $request->getAttribute('customer_id');
        $rx         = $this->prescriptions->findById((string) $args['id']);
        if ($rx === null || $rx->getPatientId() !== $customerId || $rx->isDraft()) {
            return $this->error($response, 'Prescription not found', 404);
        }
        $body = (array) ($request->getParsedBody() ?? []);

        return $this->success(
            $response,
            $this->service->issueLink($rx, 'patient', $customerId, filter_var($body['download'] ?? false, FILTER_VALIDATE_BOOLEAN)),
        )->withHeader('Cache-Control', 'no-store');
    }
}
