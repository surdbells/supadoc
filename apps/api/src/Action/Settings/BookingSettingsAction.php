<?php

declare(strict_types=1);

namespace App\Action\Settings;

use App\Domain\Settings\BookingSettings;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET / PATCH /api/settings/booking — the booking rules the Platform Admin can
 * change without a release ({@see BookingSettings}): how far ahead patients
 * may book (horizon_days 7–180), the minimum notice (lead_minutes 15–1440),
 * the "few left" threshold (few_left 1–10), and how past consultations close
 * — missed_after_hours 1–168, unconfirmed_expiry_minutes_after_end 0–1440,
 * noshow_patient_refund_pct / noshow_both_refund_pct 0–100, late_cancel_hours
 * 0–168, late_cancel_refund_pct 0–100, doctor_noshow_alert_threshold 1–20.
 * Out-of-range values → 422 per field. `settings.manage`.
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
