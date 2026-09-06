import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import type { PricingDto, SuccessResponse } from '@supadoc/models';
import { ApiService } from './api.service';

export interface UpdatePricingParams {
  currency?: string;
  guest_fee?: number | string;
  platform_fee?: number | string;
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
}
