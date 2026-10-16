import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import type {
  AdminDashboardDto,
  AdminDashboardPeriod,
  AdminDashboardQuery,
  SuccessResponse,
} from '@supadoc/models';
import { ApiService } from './api.service';
import { viewerTimeZone } from './date-input';

/**
 * Back-office dashboard API (GET /api/admin/dashboard). Staff-scoped: needs any
 * of monitoring.view, appointments.view, specialists.manage, payouts.manage or
 * support.manage, and each section comes back only for the permission its page
 * needs (read `sections` / `parts`). A doctor login gets 403.
 */
@Injectable({ providedIn: 'root' })
export class AdminDashboardApi {
  private readonly api = inject(ApiService);

  /**
   * The dashboard for `period` (default today), on the viewer's calendar
   * (`tz` defaults to the browser's zone). `refresh: true` skips the short
   * server cache. 422 `errors.period` for an unknown period.
   */
  get(
    period: AdminDashboardPeriod = 'today',
    options: Omit<AdminDashboardQuery, 'period'> = {},
  ): Observable<SuccessResponse<AdminDashboardDto>> {
    return this.api.get<SuccessResponse<AdminDashboardDto>>('api/admin/dashboard', {
      period,
      tz: options.tz ?? viewerTimeZone(),
      refresh: options.refresh ? 1 : undefined,
    });
  }
}
