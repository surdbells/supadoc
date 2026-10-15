<?php

declare(strict_types=1);

namespace App\Tests\Integration\Card\Support;

use App\Infrastructure\Service\CardPaymentGateway;

/**
 * Paystack's verify, answered from a JSON file instead of the network — shared
 * by the test and its worker processes:
 *   {"<reference>": {"status": "success", "amount_minor": 1000000, "currency": "NGN",
 *                    "metadata": {...}, "paid_at": "2026-10-15T10:00:00.000Z"}}
 * A reference with `"unreachable": true` (or none at all) throws like a
 * network failure. Every call is appended to `<file>.calls`, so a test can
 * count how often Paystack was asked about a payment.
 */
final class FakeCardGateway implements CardPaymentGateway
{
    public function __construct(private readonly string $file)
    {
    }

    public function isConfigured(): bool
    {
        return true;
    }

    public function verify(string $reference): array
    {
        file_put_contents($this->file . '.calls', $reference . "\n", FILE_APPEND | LOCK_EX);
        $answers = is_file($this->file) ? json_decode((string) file_get_contents($this->file), true) : [];
        $answer  = is_array($answers) ? ($answers[$reference] ?? null) : null;
        if (!is_array($answer) || ($answer['unreachable'] ?? false) === true) {
            throw new \RuntimeException('Payment service unreachable (fake)');
        }
        if (isset($answer['sleep_ms'])) {
            usleep((int) $answer['sleep_ms'] * 1000);
        }

        $status = (string) ($answer['status'] ?? 'failed');

        return [
            'status'            => $status,
            'amount_minor'      => (int) ($answer['amount_minor'] ?? 0),
            'currency'          => strtoupper((string) ($answer['currency'] ?? 'NGN')),
            'reference'         => $reference,
            'gateway_reference' => (string) ($answer['gateway_reference'] ?? ('gw_' . substr(md5($reference), 0, 10))),
            // What the checkout recorded with Paystack, and when it was paid (default: just now).
            'metadata'          => is_array($answer['metadata'] ?? null) ? $answer['metadata'] : [],
            'paid_at'           => array_key_exists('paid_at', $answer) ? $answer['paid_at'] : ($status === 'success' ? gmdate('Y-m-d\TH:i:s.000\Z') : null),
        ];
    }

    /** Set what Paystack says about `$reference`. @param array<string,mixed> $answer */
    public static function answer(string $file, string $reference, array $answer): void
    {
        $answers             = is_file($file) ? (array) json_decode((string) file_get_contents($file), true) : [];
        $answers[$reference] = $answer;
        file_put_contents($file, (string) json_encode($answers), LOCK_EX);
    }

    /** How many times Paystack was asked about `$reference`. */
    public static function calls(string $file, string $reference): int
    {
        if (!is_file($file . '.calls')) {
            return 0;
        }

        return count(array_filter(
            explode("\n", (string) file_get_contents($file . '.calls')),
            static fn (string $line): bool => $line === $reference,
        ));
    }
}
