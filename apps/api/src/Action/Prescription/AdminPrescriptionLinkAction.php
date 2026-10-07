<?php

declare(strict_types=1);

namespace App\Action\Prescription;

use App\Domain\Repository\PrescriptionRepository;
use App\Infrastructure\Prescription\PrescriptionService;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/admin/prescriptions/{rxId}/link — {download?} a short-lived signed
 * URL to a sent prescription's PDF for authorised staff (`monitoring.view`).
 * Drafts stay private to their doctor. The file fetch itself is audited.
 */
final class AdminPrescriptionLinkAction
{
    use ApiResponse;

    public function __construct(
        private readonly PrescriptionRepository $prescriptions,
        private readonly PrescriptionService $service,
    ) {
    }

    public function __invoke(ServerRequestInterface $request, ResponseInterface $response, array $args): ResponseInterface
    {
        $rx = $this->prescriptions->findById((string) $args['rxId']);
        if ($rx === null || $rx->isDraft()) {
            return $this->error($response, 'Prescription not found', 404);
        }
        $body = (array) ($request->getParsedBody() ?? []);

        return $this->success(
            $response,
            $this->service->issueLink($rx, 'staff', (string) $request->getAttribute('user_id'), filter_var($body['download'] ?? false, FILTER_VALIDATE_BOOLEAN)),
        )->withHeader('Cache-Control', 'no-store');
    }
}
