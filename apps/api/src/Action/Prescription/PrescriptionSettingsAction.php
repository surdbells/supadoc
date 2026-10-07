<?php

declare(strict_types=1);

namespace App\Action\Prescription;

use App\Infrastructure\Prescription\PrescriptionSettings;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET / PATCH /api/settings/prescriptions — the prescription rules the Platform
 * Admin can change without a release: default validity, expiry-reminder lead
 * time, check-page lock-out and download-link lifetime. `settings.manage`.
 */
final class PrescriptionSettingsAction
{
    use ApiResponse;

    public function __construct(private readonly PrescriptionSettings $settings)
    {
    }

    public function __invoke(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        if ($request->getMethod() === 'PATCH') {
            return $this->success(
                $response,
                $this->settings->update((array) ($request->getParsedBody() ?? [])),
                'Prescription settings updated',
            );
        }

        return $this->success($response, $this->settings->all());
    }
}
