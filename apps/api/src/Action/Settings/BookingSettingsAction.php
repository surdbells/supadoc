<?php

declare(strict_types=1);

namespace App\Action\Settings;

use App\Domain\Settings\BookingSettings;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET / PATCH /api/settings/booking — the booking-calendar rules the Platform
 * Admin can change without a release: how far ahead patients may book
 * (horizon_days 7–180), the minimum notice (lead_minutes 15–1440) and the
 * "few left" threshold (few_left 1–10). `settings.manage`.
 */
final class BookingSettingsAction
{
    use ApiResponse;

    public function __construct(private readonly BookingSettings $settings)
    {
    }

    public function __invoke(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        if ($request->getMethod() === 'PATCH') {
            return $this->success(
                $response,
                $this->settings->update((array) ($request->getParsedBody() ?? [])),
                'Booking settings updated',
            );
        }

        return $this->success($response, $this->settings->all());
    }
}
