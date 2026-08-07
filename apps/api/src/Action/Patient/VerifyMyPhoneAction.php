<?php

declare(strict_types=1);

namespace App\Action\Patient;

use App\Domain\Entity\Patient;
use App\Domain\Repository\PatientRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\JwtService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/portal/me/verify-phone — the signed-in patient confirms (or updates
 * to) a just-verified number. Consumes the phone-proof token from verify-otp and
 * stamps the account as phone-verified.
 */
final class VerifyMyPhoneAction
{
    use ApiResponse;

    public function __construct(
        private readonly JwtService $jwt,
        private readonly PatientRepository $patients,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        $customerId = (string) $request->getAttribute('customer_id');
        $body       = (array) $request->getParsedBody();
        $token      = trim((string) ($body['verification_token'] ?? ''));

        if ($token === '') {
            return $this->error($response, 'Validation failed', 422, [
                'verification_token' => 'Phone verification is required',
            ]);
        }

        $phone = $this->jwt->verifyPhoneProof($token);
        if ($phone === null) {
            return $this->error($response, 'Phone verification expired — please verify again', 401);
        }

        /** @var Patient $patient */
        $patient = $this->patients->findOrFail($customerId);

        $other = $this->patients->findByPhone($phone);
        if ($other !== null && $other->getId() !== $patient->getId()) {
            return $this->error($response, 'That number is linked to another account', 422, [
                'phone' => 'This number is already in use',
            ]);
        }

        $patient->setPhone($phone);
        $patient->markPhoneVerified();
        $this->patients->save($patient);

        return $this->success($response, $patient->toArray(), 'Phone number verified');
    }
}
