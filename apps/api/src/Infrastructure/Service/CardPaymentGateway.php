<?php

declare(strict_types=1);

namespace App\Infrastructure\Service;

/**
 * The one question card-payment code asks the gateway: what happened to the
 * transaction under this reference? ({@see PaystackCardGateway} in production;
 * tests answer it without any network.)
 *
 * `status` is the gateway's own word (success, failed, abandoned, reversed,
 * ongoing, pending, …) or {@see NOT_FOUND} when the gateway has no
 * transaction under the reference at all. `metadata` is what the checkout
 * recorded with the gateway (patient_id, purpose, …), `paid_at` when it was
 * paid (ISO-8601), if it was.
 */
interface CardPaymentGateway
{
    /** The gateway has no transaction under this reference (never paid — e.g. a checkout that never opened). */
    public const NOT_FOUND = 'not_found';

    /** Statuses after which a charge will never become successful. */
    public const FINAL_UNPAID = ['failed', 'abandoned', 'reversed'];

    public function isConfigured(): bool;

    /**
     * @return array{status:string, amount_minor:int, currency:string, reference:string, gateway_reference:?string, metadata?:array<string,mixed>, paid_at?:?string}
     * @throws \RuntimeException when the gateway can't be reached or answers oddly (transient — try again later)
     */
    public function verify(string $reference): array;
}
