import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import type {
  AuditEventDto,
  MonitoringConsultationRow,
  MonitoringOverviewDto,
  MonitoringQualityDto,
  PaginatedResponse,
  RecordingDto,
  SuccessResponse,
} from '@supadoc/models';
import { ApiService, QueryParams } from './api.service';

/**
 * Back-office monitoring API — the `/api/admin/monitoring/*` reads that power the
 * console dashboard. All require the `monitoring.view` permission (enforced
 * server-side; the console also gates the nav with `permissionGuard`).
 */
@Injectable({ providedIn: 'root' })
export class MonitoringApi {
  private readonly api = inject(ApiService);

  overview(): Observable<SuccessResponse<MonitoringOverviewDto>> {
    return this.api.get<SuccessResponse<MonitoringOverviewDto>>(
      'api/admin/monitoring/overview',
    );
  }

  consultations(
    query?: { page?: number; per_page?: number },
  ): Observable<PaginatedResponse<MonitoringConsultationRow>> {
    return this.api.get<PaginatedResponse<MonitoringConsultationRow>>(
      'api/admin/monitoring/consultations',
      query as QueryParams | undefined,
    );
  }

  quality(): Observable<SuccessResponse<MonitoringQualityDto>> {
    return this.api.get<SuccessResponse<MonitoringQualityDto>>(
      'api/admin/monitoring/quality',
    );
  }

  recordings(): Observable<SuccessResponse<RecordingDto[]>> {
    return this.api.get<SuccessResponse<RecordingDto[]>>(
      'api/admin/monitoring/recordings',
    );
  }

  audit(
    query?: { page?: number; per_page?: number; action?: string },
  ): Observable<PaginatedResponse<AuditEventDto>> {
    return this.api.get<PaginatedResponse<AuditEventDto>>(
      'api/admin/monitoring/audit',
      query as QueryParams | undefined,
    );
  }
}
