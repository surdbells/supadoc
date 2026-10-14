<?php

declare(strict_types=1);

namespace App\Action\Settings;

use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\PricingService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * PATCH /api/settings/pricing — back-office updates consultation pricing
 * (currency, guest_fee, platform_fee, and the follow-up rules:
 * follow_up_fee_mode, follow_up_discount_percent, follow_up_window_days).
 * Staff-scoped and gated on `settings.manage`. Only the keys present in the
 * body are changed.
 */
final class UpdatePricingAction
{
    use ApiResponse;

    private const KEYS = [
        'currency',
        'guest_fee',
        'platform_fee',
        'follow_up_fee_mode',
        'follow_up_discount_percent',
        'follow_up_window_days',
    ];

    public function __construct(private readonly PricingService $pricing)
    {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        $body  = (array) $request->getParsedBody();
        $patch = [];

        foreach (self::KEYS as $key) {
            if (array_key_exists($key, $body)) {
                $patch[$key] = $body[$key];
            }
        }

        $errors = [];
        foreach (['guest_fee', 'platform_fee'] as $key) {
            if (isset($patch[$key]) && (!is_numeric($patch[$key]) || (float) $patch[$key] < 0)) {
                $errors[$key] = 'Must be a non-negative amount';
            }
        }
        if (isset($patch['currency']) && trim((string) $patch['currency']) === '') {
            $errors['currency'] = 'Currency is required';
        }
        if (isset($patch['follow_up_fee_mode'])) {
            $patch['follow_up_fee_mode'] = strtolower(trim((string) $patch['follow_up_fee_mode']));
            if (!in_array($patch['follow_up_fee_mode'], PricingService::FOLLOW_UP_MODES, true)) {
                $errors['follow_up_fee_mode'] = 'Choose full, percent or free';
            }
        }
        if (isset($patch['follow_up_discount_percent']) && !$this->isWholeNumberIn($patch['follow_up_discount_percent'], 0, 100)) {
            $errors['follow_up_discount_percent'] = 'Must be a whole number from 0 to 100';
        }
        if (isset($patch['follow_up_window_days']) && !$this->isWholeNumberIn($patch['follow_up_window_days'], 1, PricingService::MAX_FOLLOW_UP_WINDOW_DAYS)) {
            $errors['follow_up_window_days'] = 'Must be a whole number of days from 1 to ' . PricingService::MAX_FOLLOW_UP_WINDOW_DAYS;
        }
        if ($errors !== []) {
            return $this->error($response, 'Validation failed', 422, $errors);
        }

        return $this->success($response, $this->pricing->update($patch), 'Pricing updated');
    }

    private function isWholeNumberIn(mixed $value, int $min, int $max): bool
    {
        if (is_int($value)) {
            return $value >= $min && $value <= $max;
        }
        if (!is_string($value) || preg_match('/^\d+$/', trim($value)) !== 1) {
            return false;
        }

        return (int) $value >= $min && (int) $value <= $max;
    }
}
