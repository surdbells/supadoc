<?php

declare(strict_types=1);

namespace App\Action\Auth;

use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\JwtService;
use App\Infrastructure\Service\TermiiService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/portal/auth/phone/verify-otp — check a code against a pin id. On
 * success it returns a short-lived `verification_token` (a phone proof) that the
 * register/login-by-phone endpoints consume, so the single-use OTP is checked
 * exactly once.
 */
final class VerifyPhoneOtpAction
{
    use ApiResponse;

    public function __construct(
        private readonly TermiiService $termii,
        private readonly JwtService $jwt,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        $body      = (array) $request->getParsedBody();
        $pinId     = trim((string) ($body['pin_id'] ?? ''));
        $otp       = trim((string) ($body['otp'] ?? ''));
        $phoneHint = trim((string) ($body['phone'] ?? ''));

        $errors = [];
        if ($pinId === '') {
            $errors['pin_id'] = 'pin_id is required';
        }
        if ($otp === '') {
            $errors['otp'] = 'The verification code is required';
        }
        if ($errors !== []) {
            return $this->error($response, 'Validation failed', 422, $errors);
        }
        if (!$this->termii->isConfigured()) {
            return $this->error($response, 'Phone verification is not configured', 503);
        }

        try {
            $verifiedPhone = $this->termii->verifyOtp($pinId, $otp);
        } catch (\Throwable) {
            return $this->error($response, 'Could not verify the code', 502);
        }

        if ($verifiedPhone === null) {
            return $this->error($response, 'Invalid or expired code', 422, [
                'otp' => 'The code is incorrect or has expired',
            ]);
        }

        // Prefer Termii's msisdn; fall back to the number the client requested for.
        $phone = $verifiedPhone !== '' ? $verifiedPhone : $phoneHint;

        return $this->success($response, [
            'verified'           => true,
            'verification_token' => $this->jwt->issuePhoneProof($phone),
        ], 'Phone verified');
    }
}
