<?php

declare(strict_types=1);

namespace App\Infrastructure\Service;

use App\Domain\Repository\AppSettingRepository;

/**
 * Consultation pricing, back-office configurable and persisted via app_settings.
 * Currency is Naira. `guest_fee` is what each extra invited attendee adds to a
 * booking; `platform_fee` is the checkout add-on shown at payment.
 */
final class PricingService
{
    private const DEFAULTS = [
        'currency'     => 'NGN',
        'guest_fee'    => '5000',
        'platform_fee' => '200',
    ];

    public function __construct(private readonly AppSettingRepository $settings)
    {
    }

    public function currency(): string
    {
        return (string) $this->settings->get('currency', self::DEFAULTS['currency']);
    }

    public function guestFee(): float
    {
        return (float) $this->settings->get('guest_fee', self::DEFAULTS['guest_fee']);
    }

    public function platformFee(): float
    {
        return (float) $this->settings->get('platform_fee', self::DEFAULTS['platform_fee']);
    }

    /** @return array{currency:string, guest_fee:float, platform_fee:float} */
    public function all(): array
    {
        return [
            'currency'     => $this->currency(),
            'guest_fee'    => $this->guestFee(),
            'platform_fee' => $this->platformFee(),
        ];
    }

    /** Persist any of currency / guest_fee / platform_fee from a patch. */
    public function update(array $patch): array
    {
        foreach (['currency', 'guest_fee', 'platform_fee'] as $key) {
            if (array_key_exists($key, $patch) && $patch[$key] !== null && $patch[$key] !== '') {
                $this->settings->set($key, (string) $patch[$key]);
            }
        }

        return $this->all();
    }
}
