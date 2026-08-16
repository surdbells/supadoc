<?php

declare(strict_types=1);

namespace App\Action\Settings;

use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\PricingService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * PATCH /api/settings/pricing — back-office updates consultation pricing
 * (currency, guest_fee, platform_fee). Staff-scoped and gated on
 * `settings.manage`. Only the keys present in the body are changed.
 */
final class UpdatePricingAction
{
    use ApiResponse;

    public function __construct(private readonly PricingService $pricing)
    {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        $body  = (array) $request->getParsedBody();
        $patch = [];

        foreach (['currency', 'guest_fee', 'platform_fee'] as $key) {
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
        if ($errors !== []) {
            return $this->error($response, 'Validation failed', 422, $errors);
        }

        return $this->success($response, $this->pricing->update($patch), 'Pricing updated');
    }
}
