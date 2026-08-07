<?php

declare(strict_types=1);

namespace App\Action\Patient;

use App\Domain\Entity\Patient;
use App\Domain\Repository\PatientRepository;
use App\Domain\Settings\PatientSettings;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * PATCH /api/portal/me/settings — update the signed-in patient's preferences.
 * Accepts a partial map; only known keys are applied (see {@see PatientSettings}).
 */
final class UpdateMySettingsAction
{
    use ApiResponse;

    public function __construct(private readonly PatientRepository $patients)
    {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        $customerId = (string) $request->getAttribute('customer_id');
        $body       = (array) $request->getParsedBody();

        if (!PatientSettings::hasKnownKeys($body)) {
            return $this->error($response, 'Validation failed', 422, [
                'settings' => 'No known settings to update',
            ]);
        }

        /** @var Patient $patient */
        $patient  = $this->patients->findOrFail($customerId);
        $settings = $patient->updateSettings($body);
        $this->patients->save($patient);

        return $this->success($response, $settings, 'Settings updated');
    }
}
