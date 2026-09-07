import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import type {
  PaginatedResponse,
  StaffNotificationDto,
  SuccessResponse,
} from '@supadoc/models';
import { ApiService, QueryParams } from './api.service';

/** In-app notifications for the signed-in staff user (doctor/admin). */
@Injectable({ providedIn: 'root' })
export class StaffNotificationsApi {
  private readonly api = inject(ApiService);

  list(query?: {
    page?: number;
    per_page?: number;
    unread?: boolean;
  }): Observable<PaginatedResponse<StaffNotificationDto>> {
    return this.api.get<PaginatedResponse<StaffNotificationDto>>(
      'api/me/notifications',
      query as QueryParams | undefined,
    );
  }

  unread(): Observable<SuccessResponse<{ count: number }>> {
    return this.api.get<SuccessResponse<{ count: number }>>('api/me/notifications/unread');
  }

  markRead(id: string): Observable<SuccessResponse<StaffNotificationDto>> {
    return this.api.post<SuccessResponse<StaffNotificationDto>>(
      `api/me/notifications/${encodeURIComponent(id)}/read`,
      {},
    );
  }

  markAllRead(): Observable<SuccessResponse<{ read: boolean }>> {
    return this.api.post<SuccessResponse<{ read: boolean }>>('api/me/notifications/read-all', {});
  }
}
