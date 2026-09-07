<?php

declare(strict_types=1);

namespace App\Action\Patient;

use App\Domain\Entity\Patient;
use App\Domain\Repository\PatientRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\TotpService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/portal/me/2fa/enable — confirm and activate two-factor auth with a
 * code from the authenticator. On success, returns the one-time recovery codes
 * (shown to the patient exactly once; only their hashes are stored).
 */
final class EnableTwoFactorAction
{
    use ApiResponse;

    private const BACKUP_CODE_COUNT = 10;

    public function __construct(
        private readonly PatientRepository $patients,
        private readonly TotpService $totp,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        $customerId = (string) $request->getAttribute('customer_id');
        $code       = trim((string) (((array) $request->getParsedBody())['code'] ?? ''));

        /** @var Patient $patient */
        $patient = $this->patients->findOrFail($customerId);
        if ($patient->isTwoFactorEnabled()) {
            return $this->error($response, 'Two-factor authentication is already enabled', 409);
        }

        $secret = (string) $patient->getTotpSecret();
        if ($secret === '') {
            return $this->error($response, 'Start setup first', 409, ['secret' => 'No pending setup — call /2fa/setup']);
        }
        if ($code === '' || !$this->totp->verify($secret, $code)) {
            return $this->error($response, 'That code is incorrect. Check your authenticator and try again.', 422, [
                'code' => 'Invalid code',
            ]);
        }

        $plain  = $this->generateBackupCodes(self::BACKUP_CODE_COUNT);
        $hashes = array_map(
            static fn (string $c): string => password_hash(Patient::normalizeBackupCode($c), PASSWORD_DEFAULT),
            $plain,
        );
        $patient->enableTwoFactor($hashes);
        $this->patients->save($patient);

        return $this->success($response, [
            'enabled'      => true,
            'backup_codes' => $plain,
        ], 'Two-factor authentication enabled')->withHeader('Cache-Control', 'no-store');
    }

    /**
     * Human-friendly recovery codes, e.g. "4K7Q-9XM2". Ambiguous characters are
     * excluded from the alphabet.
     *
     * @return list<string>
     */
    private function generateBackupCodes(int $count): array
    {
        $alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        $codes    = [];
        for ($i = 0; $i < $count; $i++) {
            $raw = '';
            for ($j = 0; $j < 8; $j++) {
                $raw .= $alphabet[random_int(0, strlen($alphabet) - 1)];
            }
            $codes[] = substr($raw, 0, 4) . '-' . substr($raw, 4, 4);
        }

        return $codes;
    }
}
