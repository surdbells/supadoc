import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import type {
  AppointmentDto,
  CallTokenDto,
  ListAppointmentsQuery,
  PaginatedResponse,
  SuccessResponse,
} from '@supadoc/models';
import { ApiService, QueryParams } from './api.service';

/**
 * Appointments client for the VideoMed backend. `listMine` hits the customer
 * portal route — the API scopes it to the signed-in patient via the bearer
 * token, so callers never pass a patient id.
 */
@Injectable({ providedIn: 'root' })
export class AppointmentsApi {
  private readonly api = inject(ApiService);

  /** GET /api/portal/appointments — the signed-in patient's own appointments. */
  listMine(
    query?: ListAppointmentsQuery,
  ): Observable<PaginatedResponse<AppointmentDto>> {
    return this.api.get<PaginatedResponse<AppointmentDto>>(
      'api/portal/appointments',
      query as QueryParams | undefined,
    );
  }

  /** GET /api/portal/appointments/{id} — one of the patient's own appointments. */
  getMine(id: string): Observable<SuccessResponse<AppointmentDto>> {
    return this.api.get<SuccessResponse<AppointmentDto>>(
      `api/portal/appointments/${encodeURIComponent(id)}`,
    );
  }

  /** POST /api/portal/appointments — book a consultation for the signed-in patient. */
  book(params: {
    specialist_id: string;
    scheduled_at: string;
    type: string;
  }): Observable<SuccessResponse<AppointmentDto>> {
    return this.api.post<SuccessResponse<AppointmentDto>>(
      'api/portal/appointments',
      params,
    );
  }

  /** GET /api/portal/appointments/{id}/call-token — Agora RTC join credentials. */
  callToken(id: string): Observable<SuccessResponse<CallTokenDto>> {
    return this.api.get<SuccessResponse<CallTokenDto>>(
      `api/portal/appointments/${encodeURIComponent(id)}/call-token`,
    );
  }
}
