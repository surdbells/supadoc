<?php

declare(strict_types=1);

namespace App\Action\Auth;

use App\Domain\Repository\PatientRepository;
use App\Infrastructure\Email\EmailOtpService;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/portal/auth/email/request-otp — email a verification code.
 * `purpose` is `register` (email must be free) or `reset` (account must exist).
 * In dev the response includes `dev_code` so the flow is testable without mail.
 */
final class RequestEmailOtpAction
{
    use ApiResponse;

    public function __construct(
        private readonly EmailOtpService $otp,
        private readonly PatientRepository $patients,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        $body    = (array) $request->getParsedBody();
        $email   = strtolower(trim((string) ($body['email'] ?? '')));
        $purpose = ($body['purpose'] ?? 'register') === 'reset' ? 'reset' : 'register';

        if ($email === '' || !filter_var($email, FILTER_VALIDATE_EMAIL)) {
            return $this->error($response, 'Validation failed', 422, ['email' => 'A valid email is required']);
        }

        $exists = $this->patients->findByEmail($email) !== null;
        if ($purpose === 'register' && $exists) {
            return $this->error($response, 'Validation failed', 422, [
                'email' => 'An account with this email already exists',
            ]);
        }
        if ($purpose === 'reset' && !$exists) {
            return $this->error($response, 'No account is registered with this email', 404);
        }

        $devCode = $this->otp->request($email, $purpose);

        $data = ['sent' => true];
        if ($devCode !== null) {
            $data['dev_code'] = $devCode; // non-production only
        }

        return $this->success($response, $data, 'Verification code sent');
    }
}
