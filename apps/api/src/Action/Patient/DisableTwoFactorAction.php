<?php

declare(strict_types=1);

namespace App\Action\Patient;

use App\Domain\Entity\Patient;
use App\Domain\Repository\PatientRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/portal/me/2fa/disable — turn two-factor auth off. Requires the
 * account password as a step-up, so a walk-up on an unlocked session can't
 * silently weaken the account.
 */
final class DisableTwoFactorAction
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
        $password   = (string) (((array) $request->getParsedBody())['password'] ?? '');

        /** @var Patient $patient */
        $patient = $this->patients->findOrFail($customerId);
        if (!$patient->isTwoFactorEnabled()) {
            return $this->success($response, ['enabled' => false], 'Two-factor authentication is already off');
        }

        if ($password === '' || !$patient->verifyPassword($password)) {
            return $this->error($response, 'Password is incorrect', 422, ['password' => 'Enter your current password']);
        }

        $patient->disableTwoFactor();
        $this->patients->save($patient);

        return $this->success($response, ['enabled' => false], 'Two-factor authentication disabled');
    }
}
