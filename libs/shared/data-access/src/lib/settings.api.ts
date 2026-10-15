import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import type { BookingSettingsDto, FollowUpFeeMode, PricingDto, SuccessResponse } from '@supadoc/models';
import { ApiService } from './api.service';

export interface UpdatePricingParams {
  currency?: string;
  guest_fee?: number | string;
  platform_fee?: number | string;
  /** Follow-ups inside the window: full fee, fee less the discount, or free. */
  follow_up_fee_mode?: FollowUpFeeMode;
  /** Whole number 0–100 (percent mode). */
  follow_up_discount_percent?: number;
  /** Whole number of days 1–365 after the original consultation's start. */
  follow_up_window_days?: number;
}

/**
 * Back-office settings API. Pricing is read via the public endpoint (there is no
 * staff GET) and written via the staff `settings.manage` endpoint.
 */
@Injectable({ providedIn: 'root' })
export class SettingsApi {
  private readonly api = inject(ApiService);

  /** GET /api/public/pricing — current currency + guest/platform fees. */
  getPricing(): Observable<SuccessResponse<PricingDto>> {
    return this.api.get<SuccessResponse<PricingDto>>('api/public/pricing');
  }

  /** PATCH /api/settings/pricing — update pricing (needs `settings.manage`). */
  updatePricing(
    params: UpdatePricingParams,
  ): Observable<SuccessResponse<PricingDto>> {
    return this.api.patch<SuccessResponse<PricingDto>>(
      'api/settings/pricing',
      params,
    );
  }

  /** GET /api/settings/booking — horizon, minimum notice, "few left" (needs `settings.manage`). */
  getBookingSettings(): Observable<SuccessResponse<BookingSettingsDto>> {
    return this.api.get<SuccessResponse<BookingSettingsDto>>('api/settings/booking');
  }

  /**
   * PATCH /api/settings/booking — change any of the booking rules (whole numbers:
   * horizon_days 7–180, lead_minutes 15–1440, few_left 1–10; else 422). Returns
   * the full set.
   */
  updateBookingSettings(
    params: Partial<BookingSettingsDto>,
  ): Observable<SuccessResponse<BookingSettingsDto>> {
    return this.api.patch<SuccessResponse<BookingSettingsDto>>(
      'api/settings/booking',
      params,
    );
  }
}
