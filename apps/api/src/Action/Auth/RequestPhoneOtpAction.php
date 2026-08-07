<?php

declare(strict_types=1);

namespace App\Action\Auth;

use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\TermiiService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/** POST /api/portal/auth/phone/request-otp — send an SMS verification code. */
final class RequestPhoneOtpAction
{
    use ApiResponse;

    public function __construct(private readonly TermiiService $termii)
    {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        $body  = (array) $request->getParsedBody();
        $phone = trim((string) ($body['phone'] ?? ''));

        if ($phone === '') {
            return $this->error($response, 'Validation failed', 422, [
                'phone' => 'A phone number is required',
            ]);
        }
        if (!$this->termii->isConfigured()) {
            return $this->error($response, 'Phone verification is not configured', 503);
        }

        try {
            $pinId = $this->termii->sendOtp($phone);
        } catch (\Throwable) {
            return $this->error($response, 'Could not send the verification code', 502);
        }

        return $this->success(
            $response,
            ['pin_id' => $pinId, 'to' => $phone],
            'Verification code sent',
        );
    }
}
