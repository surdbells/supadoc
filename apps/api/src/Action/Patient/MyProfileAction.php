<?php

declare(strict_types=1);

namespace App\Action\Patient;

use App\Domain\Repository\PatientRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/portal/me — the signed-in patient's own profile. `customer_id` comes
 * from CustomerAuthMiddleware; a missing account 404s via findOrFail.
 */
final class MyProfileAction
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

        /** @var \App\Domain\Entity\Patient $patient */
        $patient = $this->patients->findOrFail($customerId);

        return $this->success($response, $patient->toArray());
    }
}
