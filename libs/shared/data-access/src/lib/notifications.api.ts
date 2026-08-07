import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import type {
  NotificationDto,
  NotificationsResponse,
  SuccessResponse,
} from '@supadoc/models';
import { ApiService, QueryParams } from './api.service';

export interface ListNotificationsQuery {
  page?: number;
  per_page?: number;
  unread?: boolean;
}

/** The signed-in patient's notifications (VideoMed backend, customer portal). */
@Injectable({ providedIn: 'root' })
export class NotificationsApi {
  private readonly api = inject(ApiService);

  /** GET /api/portal/notifications — newest first; `meta.unread` is the count. */
  list(query?: ListNotificationsQuery): Observable<NotificationsResponse> {
    return this.api.get<NotificationsResponse>(
      'api/portal/notifications',
      query as QueryParams | undefined,
    );
  }

  /** POST /api/portal/notifications/{id}/read */
  markRead(id: string): Observable<SuccessResponse<NotificationDto>> {
    return this.api.post<SuccessResponse<NotificationDto>>(
      `api/portal/notifications/${encodeURIComponent(id)}/read`,
      {},
    );
  }

  /** POST /api/portal/notifications/read-all */
  markAllRead(): Observable<SuccessResponse<{ unread: number }>> {
    return this.api.post<SuccessResponse<{ unread: number }>>(
      'api/portal/notifications/read-all',
      {},
    );
  }
}
