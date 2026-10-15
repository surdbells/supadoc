<?php

declare(strict_types=1);

namespace App\Infrastructure\Service;

/**
 * {@see CardPaymentGateway} over Paystack's transaction verify API. Paystack
 * answers a reference it has no transaction for with an error ("Transaction
 * reference not found"); that is a definite answer — nothing was paid under
 * it — not an outage, so it comes back as status {@see CardPaymentGateway::NOT_FOUND}
 * instead of an exception (a checkout whose pop-up never opened must not be
 * retried as "unreachable" forever).
 */
final class PaystackCardGateway implements CardPaymentGateway
{
    public function __construct(private readonly PaystackService $paystack)
    {
    }

    public function isConfigured(): bool
    {
        return $this->paystack->isConfigured();
    }

    public function verify(string $reference): array
    {
        try {
            return $this->paystack->verify($reference);
        } catch (\RuntimeException $e) {
            if (self::isNotFound($e)) {
                return ['status' => self::NOT_FOUND, 'amount_minor' => 0, 'currency' => '', 'reference' => $reference, 'gateway_reference' => null, 'metadata' => [], 'paid_at' => null];
            }
            throw $e;
        }
    }

    /** Paystack's "no transaction under this reference" (an HTTP 400 with that message). */
    public static function isNotFound(\Throwable $e): bool
    {
        return preg_match('/^Paystack: .*reference not found/i', $e->getMessage()) === 1;
    }
}
