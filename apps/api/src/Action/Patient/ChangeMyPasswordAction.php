<?php

declare(strict_types=1);

namespace App\Action\Patient;

use App\Domain\Entity\Patient;
use App\Domain\Repository\PatientRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/portal/me/password — change the signed-in patient's password.
 * Requires the current password; the new one must be at least 8 characters.
 */
final class ChangeMyPasswordAction
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
        $current    = (string) ($body['current_password'] ?? '');
        $next       = (string) ($body['new_password'] ?? '');

        if (strlen($next) < 8) {
            return $this->error($response, 'Validation failed', 422, [
                'new_password' => 'Password must be at least 8 characters',
            ]);
        }

        /** @var Patient $patient */
        $patient = $this->patients->findOrFail($customerId);

        if (!$patient->verifyPassword($current)) {
            return $this->error($response, 'Current password is incorrect', 422, [
                'current_password' => 'Current password is incorrect',
            ]);
        }

        $patient->setPassword($next);
        $this->patients->save($patient);

        return $this->success($response, ['changed' => true], 'Password updated');
    }
}
