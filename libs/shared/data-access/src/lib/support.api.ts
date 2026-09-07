import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import type {
  CreateTicketParams,
  PaginatedResponse,
  SupportMessageDto,
  SupportStatus,
  SupportThreadDto,
  SupportTicketDto,
  SuccessResponse,
} from '@supadoc/models';
import { ApiService, QueryParams } from './api.service';

/** The patient's own support tickets (customer portal). */
@Injectable({ providedIn: 'root' })
export class SupportApi {
  private readonly api = inject(ApiService);

  list(query?: { page?: number; per_page?: number }): Observable<PaginatedResponse<SupportTicketDto>> {
    return this.api.get<PaginatedResponse<SupportTicketDto>>(
      'api/portal/support/tickets',
      query as QueryParams | undefined,
    );
  }

  create(params: CreateTicketParams): Observable<SuccessResponse<SupportTicketDto>> {
    return this.api.post<SuccessResponse<SupportTicketDto>>('api/portal/support/tickets', params);
  }

  get(id: string): Observable<SuccessResponse<SupportThreadDto>> {
    return this.api.get<SuccessResponse<SupportThreadDto>>(
      `api/portal/support/tickets/${encodeURIComponent(id)}`,
    );
  }

  reply(id: string, body: string): Observable<SuccessResponse<SupportMessageDto>> {
    return this.api.post<SuccessResponse<SupportMessageDto>>(
      `api/portal/support/tickets/${encodeURIComponent(id)}/messages`,
      { body },
    );
  }
}

/** The back-office support desk (requires `support.manage`). */
@Injectable({ providedIn: 'root' })
export class AdminSupportApi {
  private readonly api = inject(ApiService);

  list(query?: {
    page?: number;
    per_page?: number;
    status?: SupportStatus;
  }): Observable<PaginatedResponse<SupportTicketDto>> {
    return this.api.get<PaginatedResponse<SupportTicketDto>>(
      'api/admin/support/tickets',
      query as QueryParams | undefined,
    );
  }

  get(id: string): Observable<SuccessResponse<SupportThreadDto>> {
    return this.api.get<SuccessResponse<SupportThreadDto>>(
      `api/admin/support/tickets/${encodeURIComponent(id)}`,
    );
  }

  reply(id: string, body: string): Observable<SuccessResponse<SupportMessageDto>> {
    return this.api.post<SuccessResponse<SupportMessageDto>>(
      `api/admin/support/tickets/${encodeURIComponent(id)}/messages`,
      { body },
    );
  }

  setStatus(id: string, status: SupportStatus): Observable<SuccessResponse<SupportTicketDto>> {
    return this.api.patch<SuccessResponse<SupportTicketDto>>(
      `api/admin/support/tickets/${encodeURIComponent(id)}`,
      { status },
    );
  }
}
