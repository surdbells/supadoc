<?php

declare(strict_types=1);

namespace App\Infrastructure\Email;

use Predis\Client as RedisClient;

/**
 * Email verification codes. A 6-digit code is stored in Redis (single-use, TTL)
 * and emailed via MailService. In non-production `request()` also returns the
 * code so the flow is testable without a live mail provider; in production it
 * returns null.
 */
final class EmailOtpService
{
    private const TTL = 600; // 10 minutes
    private const MAX_ATTEMPTS = 5; // guesses allowed per issued code

    public function __construct(
        private readonly RedisClient $redis,
        private readonly MailService $mail,
        private readonly bool $exposeCode,
    ) {
    }

    /** Generate + store + email a code. Returns the code in dev, else null. */
    public function request(string $email, string $purpose): ?string
    {
        $code = str_pad((string) random_int(0, 999999), 6, '0', STR_PAD_LEFT);
        $this->redis->setex($this->key($email, $purpose), self::TTL, $code);

        $mail = EmailTemplates::verificationCode($code, $purpose);
        $this->mail->send($email, '', $mail['subject'], $mail['html']);

        return $this->exposeCode ? $code : null;
    }

    /**
     * Check a code (single-use — deleted on success). A per-code attempt counter
     * caps guesses so the 6-digit space can't be brute-forced within the TTL: after
     * MAX_ATTEMPTS wrong tries the code is burned and a fresh one must be requested.
     */
    public function verify(string $email, string $otp, string $purpose): bool
    {
        $key         = $this->key($email, $purpose);
        $attemptsKey = 'otp:attempts:' . $purpose . ':' . strtolower(trim($email));
        $stored      = $this->redis->get($key);

        if (!is_string($stored) || $stored === '') {
            return false;
        }

        $attempts = (int) $this->redis->incr($attemptsKey);
        if ($attempts === 1) {
            $this->redis->expire($attemptsKey, self::TTL);
        }
        if ($attempts > self::MAX_ATTEMPTS) {
            $this->redis->del([$key, $attemptsKey]);

            return false;
        }

        if (!hash_equals($stored, $otp)) {
            return false;
        }

        $this->redis->del([$key, $attemptsKey]);

        return true;
    }

    private function key(string $email, string $purpose): string
    {
        return 'otp:' . $purpose . ':' . strtolower(trim($email));
    }
}
