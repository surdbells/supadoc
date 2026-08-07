<?php

declare(strict_types=1);

namespace App\Action\Patient;

use App\Domain\Entity\Patient;
use App\Domain\Repository\PatientRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * PATCH /api/portal/me/health-profile — save one or more health-profile
 * sections. Each section present in the body replaces the stored one wholesale;
 * sections that are absent are left untouched.
 */
final class UpdateMyHealthProfileAction
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

        $known = ['emergency_contact', 'insurance', 'medical'];
        if (count(array_intersect(array_keys($body), $known)) === 0) {
            return $this->error($response, 'Validation failed', 422, [
                'health_profile' => 'No known section to update',
            ]);
        }

        /** @var Patient $patient */
        $patient = $this->patients->findOrFail($customerId);

        if (is_array($body['emergency_contact'] ?? null)) {
            $patient->setEmergencyContact($body['emergency_contact']);
        }
        if (is_array($body['insurance'] ?? null)) {
            $patient->setInsurance($body['insurance']);
        }
        if (is_array($body['medical'] ?? null)) {
            $patient->setMedical($body['medical']);
        }

        $this->patients->save($patient);

        return $this->success($response, $patient->getHealthProfile(), 'Health profile updated');
    }
}
