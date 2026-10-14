<?php

declare(strict_types=1);

namespace App\Infrastructure\Service;

use App\Domain\Repository\AppSettingRepository;
use DateTimeImmutable;

/**
 * Consultation pricing, back-office configurable and persisted via app_settings.
 * Currency is Naira. `guest_fee` is what each extra invited attendee adds to a
 * booking; `platform_fee` is the checkout add-on shown at payment.
 *
 * Follow-ups: within `follow_up_window_days` of the consultation they follow on
 * from, a follow-up costs the doctor's fee (`full`), that fee less
 * `follow_up_discount_percent` (`percent`), or nothing (`free`); later than
 * that it is the doctor's full fee. A doctor can waive it when proposing.
 */
final class PricingService
{
    public const FOLLOW_UP_MODES = ['full', 'percent', 'free'];
    public const MAX_FOLLOW_UP_WINDOW_DAYS = 365;

    private const DEFAULTS = [
        'currency'                  => 'NGN',
        'guest_fee'                 => '5000',
        'platform_fee'              => '200',
        'follow_up_fee_mode'        => 'percent',
        'follow_up_discount_percent' => '50',
        'follow_up_window_days'     => '14',
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

    /** 'full' | 'percent' | 'free' — an unknown stored value reads as the default. */
    public function followUpFeeMode(): string
    {
        $mode = (string) $this->settings->get('follow_up_fee_mode', self::DEFAULTS['follow_up_fee_mode']);

        return in_array($mode, self::FOLLOW_UP_MODES, true) ? $mode : self::DEFAULTS['follow_up_fee_mode'];
    }

    /** 0–100: the discount off the doctor's fee in `percent` mode. */
    public function followUpDiscountPercent(): int
    {
        return max(0, min(100, (int) $this->settings->get('follow_up_discount_percent', self::DEFAULTS['follow_up_discount_percent'])));
    }

    /** Follow-up pricing applies to follow-ups starting within this many days of the original consultation. */
    public function followUpWindowDays(): int
    {
        return max(1, min(self::MAX_FOLLOW_UP_WINDOW_DAYS, (int) $this->settings->get('follow_up_window_days', self::DEFAULTS['follow_up_window_days'])));
    }

    /**
     * @return array{currency:string, guest_fee:float, platform_fee:float,
     *               follow_up_fee_mode:string, follow_up_discount_percent:int, follow_up_window_days:int}
     */
    public function all(): array
    {
        return [
            'currency'                   => $this->currency(),
            'guest_fee'                  => $this->guestFee(),
            'platform_fee'               => $this->platformFee(),
            'follow_up_fee_mode'         => $this->followUpFeeMode(),
            'follow_up_discount_percent' => $this->followUpDiscountPercent(),
            'follow_up_window_days'      => $this->followUpWindowDays(),
        ];
    }

    /** Persist any of the pricing keys from a patch (validated by the caller). */
    public function update(array $patch): array
    {
        foreach (array_keys(self::DEFAULTS) as $key) {
            if (array_key_exists($key, $patch) && $patch[$key] !== null && $patch[$key] !== '') {
                $this->settings->set($key, (string) $patch[$key]);
            }
        }

        return $this->all();
    }

    /**
     * The price of a follow-up starting at `$start`, for a consultation that
     * started at `$parentStart`, under the configured rules.
     *
     * @return array{base_fee:string, amount:string, rule:string, discount_percent:int, window_days:int, window_ends_at:string, waived:bool}
     */
    public function followUpQuote(string $doctorFee, DateTimeImmutable $parentStart, DateTimeImmutable $start, bool $waived = false): array
    {
        return self::followUpPrice(
            $doctorFee,
            $this->followUpFeeMode(),
            $this->followUpDiscountPercent(),
            $this->followUpWindowDays(),
            $parentStart,
            $start,
            $waived,
        );
    }

    /**
     * Pure follow-up pricing. `rule` says which rule priced it:
     *   waived         — the doctor waived the fee (0)
     *   free           — free-follow-up mode, inside the window (0)
     *   percent        — the fee less `discount_percent`, inside the window
     *   full           — full-fee mode, inside the window
     *   outside_window — starts more than `window_days` after the original
     *                    consultation started: the doctor's full fee
     * Money is bcmath; a percentage that doesn't divide evenly rounds down to
     * the kobo, in the patient's favour.
     *
     * @return array{base_fee:string, amount:string, rule:string, discount_percent:int, window_days:int, window_ends_at:string, waived:bool}
     */
    public static function followUpPrice(
        string $doctorFee,
        string $mode,
        int $discountPercent,
        int $windowDays,
        DateTimeImmutable $parentStart,
        DateTimeImmutable $start,
        bool $waived,
    ): array {
        $fee        = bcadd($doctorFee !== '' ? $doctorFee : '0', '0', 2);
        $windowEnds = $parentStart->modify('+' . $windowDays . ' days');
        $percent    = max(0, min(100, $discountPercent));

        [$amount, $rule, $applied] = match (true) {
            $waived              => ['0.00', 'waived', 100],
            $start > $windowEnds => [$fee, 'outside_window', 0],
            $mode === 'free'     => ['0.00', 'free', 100],
            $mode === 'percent'  => [bcdiv(bcmul($fee, (string) (100 - $percent), 2), '100', 2), 'percent', $percent],
            default              => [$fee, 'full', 0],
        };

        return [
            'base_fee'         => $fee,
            'amount'           => $amount,
            'rule'             => $rule,
            'discount_percent' => $applied,
            'window_days'      => $windowDays,
            'window_ends_at'   => $windowEnds->format(DATE_ATOM),
            'waived'           => $waived,
        ];
    }
}
