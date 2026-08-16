<?php

declare(strict_types=1);

namespace App\Action\Public;

use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\PricingService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/public/pricing — the back-office-configurable pricing the booking
 * wizard needs to show a live total: currency, the per-guest fee and the
 * platform fee. Public (no auth) so the price is visible before sign-in.
 */
final class PublicPricingAction
{
    use ApiResponse;

    public function __construct(private readonly PricingService $pricing)
    {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        return $this->success($response, $this->pricing->all());
    }
}
