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

    /** Check a code (single-use — deleted on success). */
    public function verify(string $email, string $otp, string $purpose): bool
    {
        $key    = $this->key($email, $purpose);
        $stored = $this->redis->get($key);

        if (!is_string($stored) || $stored === '' || !hash_equals($stored, $otp)) {
            return false;
        }

        $this->redis->del([$key]);

        return true;
    }

    private function key(string $email, string $purpose): string
    {
        return 'otp:' . $purpose . ':' . strtolower(trim($email));
    }
}
