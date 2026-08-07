<?php

declare(strict_types=1);

namespace App\Action\Auth;

use App\Infrastructure\Email\EmailOtpService;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\JwtService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/portal/auth/email/verify-otp — verify an emailed code and return a
 * short-lived `verification_token` (email proof) for register / reset-password.
 */
final class VerifyEmailOtpAction
{
    use ApiResponse;

    public function __construct(
        private readonly EmailOtpService $otp,
        private readonly JwtService $jwt,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        $body    = (array) $request->getParsedBody();
        $email   = strtolower(trim((string) ($body['email'] ?? '')));
        $code    = trim((string) ($body['otp'] ?? ''));
        $purpose = ($body['purpose'] ?? 'register') === 'reset' ? 'reset' : 'register';

        $errors = [];
        if ($email === '') {
            $errors['email'] = 'Email is required';
        }
        if ($code === '') {
            $errors['otp'] = 'The verification code is required';
        }
        if ($errors !== []) {
            return $this->error($response, 'Validation failed', 422, $errors);
        }

        if (!$this->otp->verify($email, $code, $purpose)) {
            return $this->error($response, 'Invalid or expired code', 422, [
                'otp' => 'The code is incorrect or has expired',
            ]);
        }

        return $this->success($response, [
            'verified'           => true,
            'verification_token' => $this->jwt->issueEmailProof($email),
        ], 'Email verified');
    }
}
