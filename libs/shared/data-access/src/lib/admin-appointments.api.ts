import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import type {
  AppointmentDto,
  ListAppointmentsQuery,
  PaginatedResponse,
  SuccessResponse,
} from '@supadoc/models';
import { ApiService, QueryParams } from './api.service';

export interface CreateAppointmentParams {
  patient_id: string;
  specialist_id: string;
  scheduled_at: string;
  type?: string;
}

/**
 * Staff appointments API — the back-office `/api/appointments` routes (distinct
 * from the customer portal's `AppointmentsApi`). Gated by `appointments.*`
 * permissions server-side.
 */
@Injectable({ providedIn: 'root' })
export class AdminAppointmentsApi {
  private readonly api = inject(ApiService);

  /** GET /api/appointments — paginated, optional `status` (CSV) filter. */
  list(
    query?: ListAppointmentsQuery,
  ): Observable<PaginatedResponse<AppointmentDto>> {
    return this.api.get<PaginatedResponse<AppointmentDto>>(
      'api/appointments',
      query as QueryParams | undefined,
    );
  }

  /** GET /api/appointments/{id}. */
  get(id: string): Observable<SuccessResponse<AppointmentDto>> {
    return this.api.get<SuccessResponse<AppointmentDto>>(
      `api/appointments/${encodeURIComponent(id)}`,
    );
  }

  /** POST /api/appointments — book on a patient's behalf. */
  create(
    params: CreateAppointmentParams,
  ): Observable<SuccessResponse<AppointmentDto>> {
    return this.api.post<SuccessResponse<AppointmentDto>>(
      'api/appointments',
      params,
    );
  }

  /** PATCH /api/appointments/{id}/status — move along the lifecycle. */
  updateStatus(
    id: string,
    status: string,
  ): Observable<SuccessResponse<AppointmentDto>> {
    return this.api.patch<SuccessResponse<AppointmentDto>>(
      `api/appointments/${encodeURIComponent(id)}/status`,
      { status },
    );
  }
}
