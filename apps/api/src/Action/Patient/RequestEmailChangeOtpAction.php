<?php

declare(strict_types=1);

namespace App\Action\Patient;

use App\Domain\Entity\Patient;
use App\Domain\Repository\PatientRepository;
use App\Infrastructure\Email\EmailOtpService;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/portal/me/email/request-otp — start a change of the signed-in
 * patient's email. Validates the requested new address (well-formed, not the
 * current one, not already taken) and emails a verification code TO THE NEW
 * ADDRESS, proving the patient controls it. The change is only applied once the
 * code is confirmed (see {@see ChangeMyEmailAction}). In dev the response
 * includes `dev_code` so the flow is testable without a live mail provider.
 */
final class RequestEmailChangeOtpAction
{
    use ApiResponse;

    public function __construct(
        private readonly PatientRepository $patients,
        private readonly EmailOtpService $otp,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        $customerId = (string) $request->getAttribute('customer_id');
        $body       = (array) $request->getParsedBody();
        $newEmail   = strtolower(trim((string) ($body['email'] ?? '')));

        if ($newEmail === '' || !filter_var($newEmail, FILTER_VALIDATE_EMAIL)) {
            return $this->error($response, 'Validation failed', 422, ['email' => 'A valid email is required']);
        }

        /** @var Patient $patient */
        $patient = $this->patients->findOrFail($customerId);

        if ($newEmail === $patient->getEmail()) {
            return $this->error($response, 'Validation failed', 422, [
                'email' => 'This is already your email address',
            ]);
        }

        if ($this->patients->findByEmail($newEmail) !== null) {
            return $this->error($response, 'Validation failed', 422, [
                'email' => 'An account with this email already exists',
            ]);
        }

        $devCode = $this->otp->request($newEmail, 'change_email');

        $data = ['sent' => true];
        if ($devCode !== null) {
            $data['dev_code'] = $devCode; // non-production only
        }

        return $this->success($response, $data, 'Verification code sent');
    }
}
