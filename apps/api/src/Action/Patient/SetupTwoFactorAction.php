<?php

declare(strict_types=1);

namespace App\Action\Patient;

use App\Domain\Entity\Patient;
use App\Domain\Repository\PatientRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\TotpService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/portal/me/2fa/setup — begin enabling two-factor auth. Generates a
 * fresh TOTP secret and returns it plus the otpauth URI for the authenticator
 * app. Not active until confirmed with a valid code via the enable endpoint.
 */
final class SetupTwoFactorAction
{
    use ApiResponse;

    public function __construct(
        private readonly PatientRepository $patients,
        private readonly TotpService $totp,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        $customerId = (string) $request->getAttribute('customer_id');

        /** @var Patient $patient */
        $patient = $this->patients->findOrFail($customerId);
        if ($patient->isTwoFactorEnabled()) {
            return $this->error($response, 'Two-factor authentication is already enabled', 409);
        }

        $secret = $this->totp->generateSecret();
        $patient->setTotpSecret($secret);
        $this->patients->save($patient);

        $issuer = trim($_ENV['CLINIC_NAME'] ?? '') !== '' ? trim($_ENV['CLINIC_NAME']) : 'VideoMed';

        return $this->success($response, [
            'secret'      => $secret,
            'otpauth_uri' => $this->totp->provisioningUri($secret, $patient->getEmail(), $issuer),
        ])->withHeader('Cache-Control', 'no-store');
    }
}
