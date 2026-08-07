<?php

declare(strict_types=1);

namespace App\Action\Patient;

use App\Domain\Entity\Patient;
use App\Domain\Repository\PatientRepository;
use App\Infrastructure\Service\ApiResponse;
use DateTimeImmutable;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * PATCH /api/portal/me — update the signed-in patient's own profile. Only the
 * fields present in the body are changed. Changing the phone clears its
 * verified status (re-verify via the phone OTP flow).
 */
final class UpdateMyProfileAction
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

        /** @var Patient $patient */
        $patient = $this->patients->findOrFail($customerId);

        if (array_key_exists('first_name', $body)) {
            $first = trim((string) $body['first_name']);
            if ($first === '') {
                return $this->error($response, 'Validation failed', 422, ['first_name' => 'First name is required']);
            }
            $patient->setFirstName($first);
        }
        if (array_key_exists('last_name', $body)) {
            $patient->setLastName(trim((string) $body['last_name']));
        }
        if (array_key_exists('phone', $body)) {
            $phone = trim((string) $body['phone']);
            $patient->setPhone($phone !== '' ? $phone : null);
        }
        if (array_key_exists('date_of_birth', $body)) {
            $dob = trim((string) $body['date_of_birth']);
            if ($dob === '') {
                $patient->setDateOfBirth(null);
            } else {
                try {
                    $patient->setDateOfBirth(new DateTimeImmutable($dob));
                } catch (\Throwable) {
                    return $this->error($response, 'Validation failed', 422, ['date_of_birth' => 'Invalid date']);
                }
            }
        }

        $this->patients->save($patient);

        return $this->success($response, $patient->toArray(), 'Profile updated');
    }
}
