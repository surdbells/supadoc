import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import type { PaginatedResponse, PayoutDto, SuccessResponse } from '@supadoc/models';
import { ApiService, QueryParams } from './api.service';

/** Back-office payouts API (needs `payouts.manage`). */
@Injectable({ providedIn: 'root' })
export class AdminPayoutsApi {
  private readonly api = inject(ApiService);

  list(query?: {
    page?: number;
    per_page?: number;
    status?: string;
  }): Observable<PaginatedResponse<PayoutDto>> {
    return this.api.get<PaginatedResponse<PayoutDto>>(
      'api/admin/payouts',
      query as QueryParams | undefined,
    );
  }

  approve(id: string, adminNote?: string): Observable<SuccessResponse<PayoutDto>> {
    return this.api.post<SuccessResponse<PayoutDto>>(
      `api/admin/payouts/${encodeURIComponent(id)}/approve`,
      { admin_note: adminNote },
    );
  }

  markPaid(id: string, reference?: string): Observable<SuccessResponse<PayoutDto>> {
    return this.api.post<SuccessResponse<PayoutDto>>(
      `api/admin/payouts/${encodeURIComponent(id)}/mark-paid`,
      { reference },
    );
  }

  reject(id: string, adminNote?: string): Observable<SuccessResponse<PayoutDto>> {
    return this.api.post<SuccessResponse<PayoutDto>>(
      `api/admin/payouts/${encodeURIComponent(id)}/reject`,
      { admin_note: adminNote },
    );
  }
}
