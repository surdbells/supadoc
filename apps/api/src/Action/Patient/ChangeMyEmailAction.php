<?php

declare(strict_types=1);

namespace App\Action\Patient;

use App\Domain\Entity\Patient;
use App\Domain\Repository\PatientRepository;
use App\Infrastructure\Email\EmailOtpService;
use App\Infrastructure\Email\EmailTemplates;
use App\Infrastructure\Email\MailService;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/portal/me/email — finish changing the signed-in patient's email.
 * Confirms the code emailed to the new address (see
 * {@see RequestEmailChangeOtpAction}), re-checks the address is still free, then
 * swaps the email and notifies the OLD address so the change can't happen
 * silently. Returns the updated profile.
 */
final class ChangeMyEmailAction
{
    use ApiResponse;

    public function __construct(
        private readonly PatientRepository $patients,
        private readonly EmailOtpService $otp,
        private readonly MailService $mail,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        $customerId = (string) $request->getAttribute('customer_id');
        $body       = (array) $request->getParsedBody();
        $newEmail   = strtolower(trim((string) ($body['email'] ?? '')));
        $otpCode    = trim((string) ($body['otp'] ?? ''));

        $errors = [];
        if ($newEmail === '' || !filter_var($newEmail, FILTER_VALIDATE_EMAIL)) {
            $errors['email'] = 'A valid email is required';
        }
        if ($otpCode === '') {
            $errors['otp'] = 'The verification code is required';
        }
        if ($errors !== []) {
            return $this->error($response, 'Validation failed', 422, $errors);
        }

        /** @var Patient $patient */
        $patient  = $this->patients->findOrFail($customerId);
        $oldEmail = $patient->getEmail();

        if ($newEmail === $oldEmail) {
            return $this->error($response, 'Validation failed', 422, [
                'email' => 'This is already your email address',
            ]);
        }

        // Re-check before consuming the code (someone may have claimed it since
        // the request step).
        if ($this->patients->findByEmail($newEmail) !== null) {
            return $this->error($response, 'Validation failed', 422, [
                'email' => 'An account with this email already exists',
            ]);
        }

        if (!$this->otp->verify($newEmail, $otpCode, 'change_email')) {
            return $this->error($response, 'Validation failed', 422, [
                'otp' => 'The code is invalid or has expired',
            ]);
        }

        $patient->setEmail($newEmail);
        $this->patients->save($patient);

        // Best-effort security notice to the previous address (never throws).
        $firstName = (string) ($patient->toArray()['first_name'] ?? '');
        $notice    = EmailTemplates::emailChanged($firstName, $newEmail);
        $this->mail->send($oldEmail, $firstName, $notice['subject'], $notice['html']);

        return $this->success($response, $patient->toArray(), 'Email updated');
    }
}
