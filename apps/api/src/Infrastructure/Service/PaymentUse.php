<?php

declare(strict_types=1);

namespace App\Infrastructure\Service;

/**
 * What the write a card payment pays for decided, inside the payment's
 * transaction ({@see PaymentIntentService::consume()}): it went ahead and the
 * payment paid for `$usedBy` ({@see used()}), or it didn't — a lost race, the
 * slot went — and the payment stays unused ({@see declined()}), optionally
 * credited to the patient's wallet right away.
 *
 * consume() hands it back with what happened to the money: `$credited` (the
 * whole payment went to the wallet) or `$overpaidCredited` (the part paid above
 * the price went to the wallet). The same shape serves the wallet / free path
 * of a booking, so one callback can do both.
 */
final class PaymentUse
{
    private function __construct(
        public readonly bool $used,
        public readonly ?string $usedBy,
        public readonly mixed $value,
        public readonly bool $creditToWallet,
        public readonly ?string $credited = null,
        public readonly ?string $overpaidCredited = null,
    ) {
    }

    /** It went ahead: the payment paid for `$by` (an appointment or guest id). */
    public static function used(string $by, mixed $value = null): self
    {
        return new self(true, $by, $value, false);
    }

    /** It didn't: nothing is paid for; with `$creditToWallet` the payment goes to the wallet now. */
    public static function declined(mixed $value = null, bool $creditToWallet = false): self
    {
        return new self(false, null, $value, $creditToWallet);
    }

    public function withCredited(?string $amount): self
    {
        return new self($this->used, $this->usedBy, $this->value, $this->creditToWallet, $amount, $this->overpaidCredited);
    }

    public function withOverpaidCredited(?string $amount): self
    {
        return new self($this->used, $this->usedBy, $this->value, $this->creditToWallet, $this->credited, $amount);
    }
}
